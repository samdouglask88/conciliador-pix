import { ConfirmationTokens } from './tokens'

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error('Configuração obrigatória: ' + name)
  return value
}

export function loadConfig() {
  const production = process.env.NODE_ENV === 'production'
  const confirmationUrl = new URL(required('PUBLIC_CONFIRMATION_URL'))
  if (!['http:', 'https:'].includes(confirmationUrl.protocol) || confirmationUrl.username || confirmationUrl.password ||
    confirmationUrl.search || confirmationUrl.hash || (production && confirmationUrl.protocol !== 'https:')) {
    throw new Error('URL pública de confirmação inválida.')
  }
  const entries = required('CONFIRMATION_KEYS').split(',').map(entry => {
    const [id, key, ...rest] = entry.split(':')
    if (!/^[\w-]{1,32}$/.test(id) || !key || !/^[\w-]{43}$/.test(key) || rest.length) {
      throw new Error('Formato de chaves de confirmação inválido.')
    }
    return [id, Buffer.from(key, 'base64url')] as const
  })
  const keys = new Map(entries)
  if (keys.size !== entries.length) throw new Error('Identificadores de chave duplicados.')
  const origins = [...new Set((process.env.IDENTITY_WEB_ORIGINS || confirmationUrl.origin).split(',').map(value => {
    const origin = value.trim()
    const url = new URL(origin)
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:')) {
      throw new Error('Origem web de identidade inválida.')
    }
    return origin
  }))]
  const rateKey = required('LOGIN_RATE_KEY')
  if (!/^[A-Za-z0-9_-]{43}$/.test(rateKey)) throw new Error('Chave de limites de login inválida.')
  const loginRateKey = Buffer.from(rateKey, 'base64url')
  const smtpUser = process.env.SMTP_USER
  const smtpPassword = process.env.SMTP_PASSWORD
  if (Boolean(smtpUser) !== Boolean(smtpPassword)) throw new Error('Credenciais SMTP incompletas.')
  return {
    production, confirmationUrl, origins, loginRateKey,
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    proxy: process.env.TRUSTED_PROXIES?.split(',').map(value => value.trim()).filter(Boolean) ?? [],
    databaseUrl: required('DATABASE_URL'),
    tokens: new ConfirmationTokens(required('CONFIRMATION_ACTIVE_KEY'), keys),
    smtp: {
      host: required('SMTP_HOST'), port: Number(process.env.SMTP_PORT || 1025),
      secure: process.env.SMTP_SECURE === 'true',
      requireTLS: production,
      auth: smtpUser && smtpPassword ? { user: smtpUser, pass: smtpPassword } : undefined,
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 20000,
      logger: false, debug: false,
    },
    mailFrom: required('SMTP_FROM'),
  }
}

