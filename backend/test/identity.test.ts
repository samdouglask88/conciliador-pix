import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { verify } from 'argon2'
import { Pool } from 'pg'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { migrate } from '../src/migrate'
import { createApp } from '../src/http'
import { Identity, identityPolicy } from '../src/identity'
import { MailOutbox } from '../src/outbox'
import { ConfirmationTokens, hashToken } from '../src/tokens'

const schema = 'test_' + randomUUID().replaceAll('-', '')
const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('Configure TEST_DATABASE_URL para executar os testes de integração.')
const admin = new Pool({ connectionString: url })
const pool = new Pool({ connectionString: url, options: '-c search_path=' + schema })
const keys = new Map([['old', randomBytes(32)], ['next', randomBytes(32)]])
const tokens = new ConfirmationTokens('old', keys)
const identity = new Identity(pool, tokens, { ...identityPolicy, resendLimit: 2 })
const confirmationUrl = new URL('http://localhost:5173/confirmar-email')
const delivered: { to: string; link: URL }[] = []
const outbox = new MailOutbox(pool, tokens, confirmationUrl, async message => { delivered.push(message) })
const password = 'senha de teste longa'
const account = { name: 'Ana Teste', email: ' Ana@Example.test ', password }
let app: NestExpressApplication
let endpoint: string

before(async () => {
  await admin.query('CREATE SCHEMA ' + schema)
  await migrate(pool)
  await migrate(pool)
  app = await createApp(identity)
  await app.listen(0, '127.0.0.1')
  endpoint = await app.getUrl() + '/api/identity/'
})

after(async () => {
  await app?.close()
  await pool.end()
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await admin.end()
})

beforeEach(async () => {
  delivered.length = 0
  await pool.query('DELETE FROM identity_mail_outbox; DELETE FROM identity_email_tokens; DELETE FROM identity_sessions; DELETE FROM identity_users; DELETE FROM identity_rate_limits')
})

async function post(path: string, data: object) {
  const response = await fetch(endpoint + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return { status: response.status, body: await response.json() as Record<string, string> }
}

async function latestLink(worker = outbox) {
  assert.equal(await worker.processOne(), true)
  const mail = delivered.at(-1)!
  assert.equal(mail.link.pathname, '/confirmar-email')
  assert.equal(mail.link.search, '')
  const token = new URLSearchParams(mail.link.hash.slice(1)).get('token')
  assert.ok(token)
  return token
}

const counts = async () => (await pool.query(`
  SELECT (SELECT count(*)::int FROM identity_users) users,
         (SELECT count(*)::int FROM identity_email_tokens) tokens,
         (SELECT count(*)::int FROM identity_mail_outbox) jobs`)).rows[0]

test('cadastro valida entradas, normaliza e-mail e armazena apenas hashes', async () => {
  for (const changes of [{ name: '' }, { email: 'a..b@example.test' }, { password: 'curta' }, { password: 'ç'.repeat(300) }]) {
    assert.equal((await post('register', { ...account, ...changes })).status, 400)
  }
  const registration = await post('register', account)
  assert.equal(registration.status, 202)
  assert.deepEqual(Object.keys(registration.body), ['message'])
  assert.deepEqual(await counts(), { users: 1, tokens: 1, jobs: 1 })
  const row = (await pool.query('SELECT * FROM identity_users')).rows[0]
  assert.equal(row.email, 'ana@example.test')
  assert.equal(row.email_confirmed_at, null)
  assert.equal(await verify(row.password_hash, password), true)
  const token = await latestLink()
  const persisted = (await pool.query('SELECT * FROM identity_email_tokens')).rows[0]
  assert.deepEqual(persisted.token_hash, hashToken(token))
  assert.equal(JSON.stringify(persisted).includes(token), false)
  assert.equal(JSON.stringify(registration).includes(password), false)
  assert.equal(JSON.stringify(registration).includes(row.password_hash), false)
  assert.equal(JSON.stringify(registration).includes(token), false)
})

test('cadastros simultâneos e repetidos não criam outra conta nem sobrescrevem confirmação', async () => {
  const responses = await Promise.all([post('register', account), post('register', { ...account, email: 'ANA@example.test' })])
  assert.deepEqual(responses[0], responses[1])
  assert.deepEqual(await counts(), { users: 1, tokens: 1, jobs: 1 })
  const token = await latestLink()
  await post('confirm', { token })
  const before = (await pool.query('SELECT * FROM identity_users')).rows[0]
  assert.deepEqual(await post('register', { ...account, name: 'Outro Nome', password: 'uma senha concorrente' }), responses[0])
  assert.deepEqual((await pool.query('SELECT * FROM identity_users')).rows[0], before)
  assert.deepEqual(await counts(), { users: 1, tokens: 1, jobs: 1 })
})

test('confirmação inválida, expirada, repetida e simultânea', async () => {
  assert.equal((await post('confirm', { token: 'A'.repeat(43) })).body.code, 'INVALID_TOKEN')
  assert.equal((await post('confirm', { token: 'curto' })).body.code, 'INVALID_TOKEN')
  await post('register', account)
  const token = await latestLink()
  await pool.query("UPDATE identity_email_tokens SET expires_at = now() - interval '1 second'")
  assert.equal((await post('confirm', { token })).body.code, 'TOKEN_EXPIRED')
  await pool.query("UPDATE identity_email_tokens SET expires_at = now() + interval '1 day'")
  const results = await Promise.all([post('confirm', { token }), post('confirm', { token })])
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409])
  assert.equal((await post('confirm', { token })).body.code, 'TOKEN_USED')
  assert.equal((await pool.query('SELECT email_confirmed_at IS NOT NULL ok FROM identity_users')).rows[0].ok, true)
})

test('reenvio genérico, limites, concorrência e invalidação do link anterior', async () => {
  const generic = await post('resend', { email: 'unknown@example.test' })
  assert.equal(generic.status, 202)
  await post('register', account)
  const old = await latestLink()
  assert.deepEqual(await post('resend', account), generic)
  assert.equal((await counts()).tokens, 1)
  const elapse = () => pool.query("UPDATE identity_email_tokens SET issued_at = issued_at - interval '61 seconds'")
  await elapse()
  assert.deepEqual(await Promise.all([post('resend', account), post('resend', account)]), [generic, generic])
  assert.equal((await counts()).tokens, 2)
  assert.equal((await post('confirm', { token: old })).body.code, 'INVALID_TOKEN')
  await elapse()
  await post('resend', account)
  assert.equal((await counts()).tokens, 3)
  await elapse()
  await post('resend', account)
  assert.equal((await counts()).tokens, 3)
  const current = await latestLink()
  assert.equal((await post('confirm', { token: current })).status, 200)
  assert.deepEqual(await post('resend', account), generic)
  assert.equal((await counts()).tokens, 3)
})

test('worker recupera falhas com tentativas limitadas e chave anterior preservada', async () => {
  await post('register', account)
  const rotated = new ConfirmationTokens('next', keys)
  const failed = new MailOutbox(pool, rotated, confirmationUrl, async () => { throw new Error('sensitive transport details') })
  for (let i = 0; i < 5; i++) {
    await pool.query('UPDATE identity_mail_outbox SET available_at = now()')
    assert.equal(await failed.processOne(), true)
  }
  assert.equal(await failed.processOne(), false)
  const row = (await pool.query('SELECT * FROM identity_mail_outbox')).rows[0]
  assert.equal(row.state, 'failed')
  assert.equal(row.attempts, 5)
  assert.equal(row.last_error, 'SMTP_DELIVERY_FAILED')
  assert.equal(await failed.recover(row.token_id), true)
  const recovered = new MailOutbox(pool, rotated, confirmationUrl, async message => { delivered.push(message) })
  const [first, second] = await Promise.all([recovered.processOne(), recovered.processOne()])
  assert.equal(Number(first) + Number(second), 1)
  const token = new URLSearchParams(delivered[0].link.hash.slice(1)).get('token')
  assert.equal((await post('confirm', { token })).status, 200)
  await new Identity(pool, rotated).register({ ...account, email: 'another@example.test' })
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM identity_email_tokens WHERE key_id = 'next'")).rows[0].count, 1)
})

test('rollback de cadastro e reenvio, sem credenciais nas respostas ou nos logs de erro', async () => {
  const logs: string[] = []
  const previous = console.error
  console.error = (...args) => { logs.push(args.join(' ')) }
  try {
    await pool.query('ALTER TABLE identity_mail_outbox ADD CONSTRAINT reject_jobs CHECK (false) NOT VALID')
    const result = await post('register', account)
    assert.equal(result.status, 500)
    assert.deepEqual(await counts(), { users: 0, tokens: 0, jobs: 0 })
    await pool.query('ALTER TABLE identity_mail_outbox DROP CONSTRAINT reject_jobs')
    await post('register', account)
    const token = await latestLink()
    const hash = (await pool.query('SELECT password_hash FROM identity_users')).rows[0].password_hash
    await pool.query("UPDATE identity_email_tokens SET issued_at = now() - interval '61 seconds'")
    await pool.query('ALTER TABLE identity_mail_outbox ADD CONSTRAINT reject_jobs CHECK (false) NOT VALID')
    assert.equal((await post('resend', account)).status, 500)
    assert.deepEqual(await counts(), { users: 1, tokens: 1, jobs: 1 })
    assert.equal((await post('confirm', { token })).status, 200)
    for (const secret of [password, hash, token, account.email]) assert.equal((JSON.stringify(result) + logs.join(' ')).includes(secret), false)
  } finally {
    console.error = previous
    await pool.query('ALTER TABLE identity_mail_outbox DROP CONSTRAINT IF EXISTS reject_jobs')
  }
})

test('limita tentativas nos três endpoints', async () => {
  for (const [route, limit, data] of [
    ['register', 10, {}], ['resend', 20, {}], ['confirm', 30, { token: 'errado' }],
  ] as const) {
    for (let i = 0; i < limit; i++) assert.equal((await post(route, data)).status, 400)
    assert.equal((await post(route, data)).status, 429)
  }
})

test('falha ao consumir o token reverte a confirmação', async () => {
  await post('register', account)
  const token = await latestLink()
  await pool.query('ALTER TABLE identity_email_tokens ADD CONSTRAINT reject_consumption CHECK (consumed_at IS NULL)')
  const previous = console.error
  console.error = () => undefined
  try {
    assert.equal((await post('confirm', { token })).status, 500)
    assert.equal((await pool.query('SELECT email_confirmed_at FROM identity_users')).rows[0].email_confirmed_at, null)
    assert.equal((await pool.query('SELECT consumed_at FROM identity_email_tokens')).rows[0].consumed_at, null)
  } finally {
    console.error = previous
    await pool.query('ALTER TABLE identity_email_tokens DROP CONSTRAINT reject_consumption')
  }
  assert.equal((await post('confirm', { token })).status, 200)
})

test('corpo malformado e excesso de tamanho retornam erros padronizados sem refletir segredos', async () => {
  for (const [raw, status, code] of [
    ['{"password":"DO_NOT_ECHO"', 400, 'INVALID_INPUT'],
    [JSON.stringify({ password: 'DO_NOT_ECHO'.repeat(1000) }), 413, 'PAYLOAD_TOO_LARGE'],
  ] as const) {
    const response = await fetch(endpoint + 'register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
    })
    assert.equal(response.status, status)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const result = await response.text()
    assert.equal(JSON.parse(result).code, code)
    assert.equal(result.includes('DO_NOT_ECHO'), false)
  }
})

test('produção exige HTTPS e ignora cabeçalho encaminhado de IP sem confiança', async () => {
  const tlsApp = await createApp(identity, true)
  try {
    await tlsApp.listen(0, '127.0.0.1')
    const response = await fetch(await tlsApp.getUrl() + '/api/identity/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify(account),
    })
    assert.equal(response.status, 426)
    assert.equal((await response.json() as { code: string }).code, 'HTTPS_REQUIRED')
    assert.equal((await counts()).users, 0)
  } finally { await tlsApp.close() }
})


