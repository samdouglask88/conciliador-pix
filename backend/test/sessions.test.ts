import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { Pool } from 'pg'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { createApp } from '../src/http'
import { Identity } from '../src/identity'
import { migrate } from '../src/migrate'
import { Sessions } from '../src/sessions'
import { ConfirmationTokens, hashToken } from '../src/tokens'

const url = process.env.TEST_DATABASE_URL
if (!url) throw new Error('Configure TEST_DATABASE_URL para executar os testes de integração.')
const schema = 'test_session_' + randomUUID().replaceAll('-', '')
const admin = new Pool({ connectionString: url })
const pool = new Pool({ connectionString: url, options: '-c search_path=' + schema })
const rateKey = randomBytes(32)
const identity = new Identity(pool, new ConfirmationTokens('local', new Map([['local', randomBytes(32)]])))
const origin = 'http://localhost:5173'
const secureOrigin = 'https://app.conciliapix.test'
const account = { name: 'Pessoa Teste', email: 'pessoa@example.test', password: 'credencial fictícia longa' }
let app: NestExpressApplication
let endpoint: string

async function launch(production = false) {
  const newApp = await createApp(identity, production, ['loopback'], {
    service: await Sessions.create(pool, rateKey),
    origins: [production ? secureOrigin : origin],
  })
  await newApp.listen(0, '127.0.0.1')
  return newApp
}

before(async () => {
  await admin.query('CREATE SCHEMA ' + schema)
  await migrate(pool)
  app = await launch()
  endpoint = await app.getUrl() + '/api/identity/'
})
after(async () => {
  await app?.close()
  await pool.end()
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE')
  await admin.end()
})
beforeEach(async () => {
  await pool.query('DELETE FROM identity_mail_outbox; DELETE FROM identity_email_tokens; DELETE FROM identity_sessions; DELETE FROM identity_users; DELETE FROM identity_rate_limits')
})

async function register(confirmed = true) {
  await identity.register(account)
  if (confirmed) await pool.query('UPDATE identity_users SET email_confirmed_at = now()')
}

function change(path: string, body: object, overrides: Record<string, string> = {}, target = endpoint) {
  return fetch(target + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: origin, 'X-ConciliaPix-CSRF': '1', ...overrides,
  }, body: JSON.stringify(body) })
}

function current(cookie?: string, target = endpoint) {
  return fetch(target + 'session', { headers: cookie ? { Cookie: cookie } : {} })
}

function cookieFrom(response: Response) {
  const cookie = response.headers.get('set-cookie')
  if (!cookie) throw new Error('Cookie esperado não foi emitido.')
  return cookie.split(';', 1)[0]
}

function sessionToken(cookie: string) { return cookie.slice(cookie.indexOf('=') + 1) }

test('login válido usa cookie HttpOnly e consulta persiste em outra instância', async () => {
  await register()
  const login = await change('login', { ...account, email: 'PESSOA@EXAMPLE.TEST' })
  assert.equal(login.status, 204)
  assert.equal(await login.text(), '')
  const cookie = cookieFrom(login)
  const settings = login.headers.get('set-cookie')!
  for (const value of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=43200']) assert.equal(settings.includes(value), true)
  assert.equal(settings.includes('Domain='), false)
  assert.equal(settings.includes('Secure'), false)
  const token = sessionToken(cookie)
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(token), true)
  const stored = (await pool.query('SELECT token_hash, absolute_expires_at FROM identity_sessions')).rows[0]
  assert.deepEqual(stored.token_hash, hashToken(token))
  assert.equal(JSON.stringify(stored).includes(token), false)
  await pool.query("UPDATE identity_sessions SET idle_expires_at = now() + interval '1 minute'")
  const second = await launch()
  try {
    const session = await current(cookie, await second.getUrl() + '/api/identity/')
    assert.equal(session.status, 200)
    assert.equal(session.headers.get('cache-control'), 'no-store')
    const body = await session.json() as { user: Record<string,string> }
    assert.deepEqual(Object.keys(body.user).sort(), ['email','id','name'])
    assert.equal(body.user.email, account.email)
    const after = (await pool.query('SELECT absolute_expires_at, idle_expires_at > now() + interval \'25 minutes\' AS extended FROM identity_sessions')).rows[0]
    assert.deepEqual(after.absolute_expires_at, stored.absolute_expires_at)
    assert.equal(after.extended, true)
  } finally { await second.close() }
})

test('senha incorreta e conta inexistente têm erro, corpo e ausência de cookie equivalentes', async () => {
  await register()
  const errors = await Promise.all([
    change('login', { ...account, password: 'senha errada' }),
    change('login', { ...account, email: 'inexistente@example.test' }),
  ])
  assert.deepEqual(errors.map(response => response.status), [401, 401])
  assert.deepEqual(errors.map(response => response.headers.get('set-cookie')), [null, null])
  const bodies = await Promise.all(errors.map(response => response.json()))
  assert.deepEqual(bodies[0], bodies[1])
  assert.equal(bodies[0].code, 'INVALID_CREDENTIALS')
})

test('conta pendente não recebe sessão e pode usar o reenvio existente', async () => {
  await register(false)
  const denied = await change('login', account)
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).code, 'EMAIL_UNCONFIRMED')
  assert.equal(denied.headers.get('set-cookie'), null)
  await pool.query("UPDATE identity_email_tokens SET issued_at = issued_at - interval '61 seconds'")
  assert.equal((await change('resend', { email: account.email })).status, 202)
  assert.equal((await pool.query("SELECT count(*)::int n FROM identity_email_tokens WHERE issued_by = 'resend'")).rows[0].n, 1)
  assert.equal((await pool.query('SELECT count(*)::int n FROM identity_sessions')).rows[0].n, 0)
})

test('limites são compartilhados por instâncias e um IP não bloqueia a conta em outro', async () => {
  await register()
  const second = await launch()
  try {
    const anotherEndpoint = await second.getUrl() + '/api/identity/'
    const source = { 'X-Forwarded-For': '198.51.100.27' }
    for (let count = 0; count < 8; count++) assert.equal((await change('login', { ...account, password: 'errada' }, source)).status, 401)
    assert.equal((await change('login', account, source, anotherEndpoint)).status, 429)
    assert.equal((await change('login', account, { 'X-Forwarded-For': '198.51.100.28' }, anotherEndpoint)).status, 204)
    const limitedSource = { 'X-Forwarded-For': '198.51.100.29' }
    for (let count = 0; count < 30; count++) assert.equal((await change('login', {}, limitedSource)).status, 400)
    assert.equal((await change('login', account, limitedSource, anotherEndpoint)).status, 429)
  } finally { await second.close() }
})

test('sessões ausentes, inválidas, expiradas e revogadas não dão acesso', async () => {
  await register()
  const missing = await current()
  assert.equal(missing.status, 401)
  assert.equal((await missing.json()).code, 'SESSION_REQUIRED')
  for (const cookie of ['conciliapix_session=malformado', 'conciliapix_session=' + randomBytes(32).toString('base64url')]) {
    const unknown = await current(cookie)
    assert.equal(unknown.status, 401)
    assert.equal(unknown.headers.get('set-cookie')?.startsWith('conciliapix_session=;'), true)
  }
  for (const update of [
    "idle_expires_at = now() - interval '1 minute'",
    "idle_expires_at = now() - interval '2 minutes', absolute_expires_at = now() - interval '1 minute'",
    'revoked_at = now()',
  ]) {
    const cookie = cookieFrom(await change('login', account))
    await pool.query('UPDATE identity_sessions SET ' + update + ' WHERE token_hash = $1', [hashToken(sessionToken(cookie))])
    const response = await current(cookie)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).code, 'SESSION_INVALID')
    assert.equal(response.headers.get('set-cookie')?.startsWith('conciliapix_session=;'), true)
  }
})

test('logout limpa o cookie, revoga no banco e impede reutilização', async () => {
  await register()
  const cookie = cookieFrom(await change('login', account))
  const logout = await change('logout', {}, { Cookie: cookie })
  assert.equal(logout.status, 204)
  assert.equal(logout.headers.get('set-cookie')?.startsWith('conciliapix_session=;'), true)
  assert.equal((await current(cookie)).status, 401)
  assert.equal((await change('logout', {}, { Cookie: cookie })).status, 204)
  assert.equal((await pool.query('SELECT revoked_at IS NOT NULL revoked FROM identity_sessions')).rows[0].revoked, true)
})

test('duas rotações concorrentes têm um vencedor; o perdedor não altera cookie', async () => {
  await register()
  const old = cookieFrom(await change('login', account))
  const races = await Promise.all([change('login', account, { Cookie: old }), change('login', account, { Cookie: old })])
  assert.deepEqual(races.map(response => response.status).sort(), [204, 409])
  const loser = races.find(response => response.status === 409)!
  assert.equal(loser.headers.get('set-cookie'), null)
  assert.equal((await loser.json()).code, 'SESSION_REPLACED')
  const next = cookieFrom(races.find(response => response.status === 204)!)
  assert.equal(next === old, false)
  assert.equal((await current(old)).status, 401)
  assert.equal((await current(next)).status, 200)
  assert.equal((await pool.query('SELECT count(*)::int n FROM identity_sessions WHERE revoked_at IS NULL')).rows[0].n, 1)
})

test('CORS explícito e prova de origem protegem login e logout', async () => {
  await register()
  for (const headers of [{ Origin: 'https://outside.test' }, { Origin: '' }, { 'X-ConciliaPix-CSRF': '' }] as Record<string, string>[]) {
    assert.equal((await change('login', account, headers)).status, 403)
  }
  const accepted = await change('login', account)
  assert.equal(accepted.headers.get('access-control-allow-origin'), origin)
  assert.equal(accepted.headers.get('access-control-allow-credentials'), 'true')
  const cookie = cookieFrom(accepted)
  const rejected = await change('logout', {}, { Cookie: cookie, Origin: 'https://outside.test' })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.headers.get('access-control-allow-origin'), null)
  assert.equal(rejected.headers.get('set-cookie'), null)
  assert.equal((await fetch(endpoint + 'session', { headers: { Cookie: cookie, 'Sec-Fetch-Site':'cross-site' } })).status, 403)
  assert.equal((await current(cookie)).status, 200)
  const preflight = await fetch(endpoint + 'login', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-ConciliaPix-CSRF',
  } })
  assert.equal(preflight.headers.get('access-control-allow-headers')?.includes('X-ConciliaPix-CSRF'), true)
})

test('cookie de produção é Secure, host-only e não é aceito como credencial em URL', async () => {
  await register()
  const production = await launch(true)
  try {
    const target = await production.getUrl() + '/api/identity/'
    const login = await change('login', account, { Origin: secureOrigin, 'X-Forwarded-Proto':'https' }, target)
    assert.equal(login.status, 204)
    const cookie = cookieFrom(login)
    const flags = login.headers.get('set-cookie')!
    assert.equal(cookie.startsWith('__Host-conciliapix_session='), true)
    assert.equal(flags.includes('Secure'), true)
    assert.equal(flags.includes('Domain='), false)
    const ignored = await fetch(target + 'session?session=ignorado', { headers: { 'X-Forwarded-Proto':'https' } })
    assert.equal(ignored.status, 401)
  } finally { await production.close() }
})

test('falhas internas e respostas indevidas não registram ou retornam credenciais', async () => {
  await register()
  const cookie = cookieFrom(await change('login', account))
  const token = sessionToken(cookie)
  const stored = (await pool.query('SELECT password_hash FROM identity_users')).rows[0].password_hash
  const logs: string[] = []
  const previous = console.error
  console.error = (...args) => { logs.push(args.join(' ')) }
  try {
    const existing = hashToken(token).toString('hex')
    await pool.query(`ALTER TABLE identity_sessions ADD CONSTRAINT reject_session
      CHECK (token_hash = decode('${existing}', 'hex'))`)
    const failed = await change('login', account, { Cookie: cookie })
    assert.equal(failed.status, 500)
    assert.equal(failed.headers.get('set-cookie'), null)
    assert.equal((await current(cookie)).status, 200)
    const rejected = await change('login', { ...account, password: 'senha inválida' }, { Cookie: cookie })
    assert.equal(rejected.status, 401)
    const observed = await failed.text() + await rejected.text() + logs.join(' ')
    assert.equal([account.password, account.email, stored, token, hashToken(token).toString('hex')].some(item => observed.includes(item)), false)
    assert.equal(logs.length > 0, true)
  } finally {
    console.error = previous
    await pool.query('ALTER TABLE identity_sessions DROP CONSTRAINT IF EXISTS reject_session')
  }
})



