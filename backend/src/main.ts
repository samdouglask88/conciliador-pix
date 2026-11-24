import { Account } from './account'
import { Finance } from './finance'
import { Tenants } from './tenants'
import { Pool } from 'pg'
import nodemailer from 'nodemailer'
import { loadConfig } from './config'
import { Identity } from './identity'
import { Sessions } from './sessions'
import { createApp } from './http'
import { MailOutbox } from './outbox'

async function main() {
  const config = loadConfig()
  const pool = new Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000 })
  pool.on('error', () => console.error('Conexão PostgreSQL interrompida.'))
  const transport = nodemailer.createTransport(config.smtp)
  const outbox = new MailOutbox(pool, config.tokens, config.confirmationUrl, async ({ to, link, purpose }) => {
    const subject = purpose === 'invite' ? 'Convite para o ConciliaPix'
      : purpose === 'reset_password' ? 'Redefina sua senha no ConciliaPix' : 'Confirme seu e-mail no ConciliaPix'
    await transport.sendMail({
      from: config.mailFrom, to, subject,
      text: [subject + '. Abra o link para continuar:', '', link.href].join(String.fromCharCode(10)),
    })
  })
  try {
    const [command, id] = process.argv.slice(2)
    if (command) {
      if (command !== 'recover-mail' || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Comando inválido.')
      console.info(await outbox.recover(id) ? 'Envio reprogramado.' : 'Envio indisponível para recuperação.')
      await pool.end()
      return
    }
    const migration = await pool.query('SELECT 1 FROM identity_migrations WHERE version = 3')
    if (!migration.rowCount) throw new Error('Migração pendente.')
    const simulatorSecret = !config.production ? process.env.SIMULATOR_SECRET : undefined
    if (simulatorSecret && !/^[A-Za-z0-9_-]{43}$/.test(simulatorSecret)) throw new Error('Chave de simulador inválida.')
    const tenants = new Tenants(pool,config.tokens)
    const finance = new Finance(pool,tenants,simulatorSecret ? {
      url: 'http://127.0.0.1:'+config.port+'/api/tenant/webhook/simulator', secret: simulatorSecret,
    } : undefined)
    const app = await createApp(new Identity(pool, config.tokens), config.production, config.proxy,
            { service: await Sessions.create(pool, config.loginRateKey), origins: config.origins,
        domain: { account:new Account(pool,config.tokens), tenants, finance, simulatorSecret } })
    await app.listen(config.port, config.host)
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    let processing: Promise<void> = Promise.resolve()
    function poll() {
      processing = (async () => {
        try {
          for (let count = 0; count < 10 && !stopped; count++) if (!await outbox.processOne()) break
        } catch { console.error('Falha ao processar a fila de confirmação.') }
        if (!stopped) timer = setTimeout(poll, 2000)
      })()
    }
    poll()
    const cacheStats = setInterval(() => console.info('tenant_cache',tenants.cacheMetrics),60000)
    const limits = setInterval(() => void pool.query(`
      DELETE FROM identity_rate_limits WHERE expires_at < now();
      DELETE FROM tenant_cache WHERE expires_at < now();
      DELETE FROM identity_sessions WHERE absolute_expires_at < now() - interval '1 day'`)
      .catch(() => console.error('Falha ao limpar limites expirados.')), 60 * 60 * 1000)
    async function close() {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      clearInterval(limits)
      clearInterval(cacheStats)
      await app.close()
      await processing
      transport.close()
      await pool.end()
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void close().catch(() => { console.error('Falha ao encerrar a API.'); process.exitCode = 1 })
    })
    console.info('API de identidade pronta.')
  } catch (error) {
    transport.close()
    await pool.end()
    throw error
  }
}

void main().catch(() => { console.error('Não foi possível iniciar a API de identidade. Confira a configuração e as migrações.'); process.exitCode = 1 })






