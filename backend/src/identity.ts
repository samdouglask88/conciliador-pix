import { randomUUID } from 'node:crypto'
import { argon2id, hash } from 'argon2'
import type { Pool, PoolClient } from 'pg'
import { transaction } from './db'
import { ConfirmationTokens, hashToken, purpose } from './tokens'

export class PublicError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicError(400, 'INVALID_INPUT', 'Informe os campos solicitados.')
  }
  return value as Record<string, unknown>
}

export function normalizeEmail(value: unknown) {
  if (typeof value === 'string' && value.length <= 320) {
    const trimmed = value.trim()
    const email = /^[\x21-\x7e]+$/.test(trimmed) ? trimmed.toLowerCase() : ''
    const [local, domain, ...rest] = email.split('@')
    if (email.length <= 254 && local && local.length <= 64 && domain && rest.length === 0 &&
      /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(domain)) return email
  }
  throw new PublicError(400, 'INVALID_EMAIL', 'Informe um e-mail válido.')
}

export const passwordHashOptions = { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const

export const identityPolicy = { tokenSeconds: 86400, resendSeconds: 60, resendWindowSeconds: 3600, resendLimit: 5 }

export class Identity {
  constructor(private pool: Pool, private tokens: ConfirmationTokens, private policy = identityPolicy) {}

  async limit(action: 'register' | 'resend' | 'confirm' | 'reset' | 'reset_request' | 'password_change', address: string) {
    const { rows } = await this.pool.query<{ hits: number }>(`
      INSERT INTO identity_rate_limits AS rate (key, hits, expires_at)
      VALUES ($1, 1, now() + interval '15 minutes')
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN rate.expires_at <= now() THEN 1 ELSE LEAST(rate.hits + 1, 1000000) END,
        expires_at = CASE WHEN rate.expires_at <= now() THEN EXCLUDED.expires_at ELSE rate.expires_at END
      RETURNING hits`, [action + ':' + hashToken(address).toString('hex')])
    const maximum = { register: 10, resend: 20, confirm: 30, reset: 15, reset_request: 10, password_change: 12 }[action]
    if (rows[0].hits > maximum) throw new PublicError(429, 'RATE_LIMITED', 'Muitas tentativas. Aguarde antes de tentar novamente.')
  }

  private async issue(client: PoolClient, userId: string, issuedBy: 'registration' | 'resend') {
    const token = this.tokens.issue()
    await client.query(`
      INSERT INTO identity_email_tokens (id, user_id, purpose, token_hash, key_id, issued_by, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 second')`,
    [token.id, userId, purpose, token.hash, token.keyId, issuedBy, this.policy.tokenSeconds])
    await client.query('INSERT INTO identity_mail_outbox (token_id) VALUES ($1)', [token.id])
  }

  async register(input: unknown) {
    const fields = bodyObject(input)
    const email = normalizeEmail(fields.email)
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    if (name.length < 2 || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new PublicError(400, 'INVALID_NAME', 'Informe um nome de 2 a 120 caracteres.')
    }
    const password = fields.password
    if (typeof password !== 'string' || [...password].length < 12 || Buffer.byteLength(password) > 512) {
      throw new PublicError(400, 'INVALID_PASSWORD', 'Informe uma senha com pelo menos 12 caracteres e até 512 bytes.')
    }
    const passwordHash = await hash(password, passwordHashOptions)
    await transaction(this.pool, async client => {
      const id = randomUUID()
      const inserted = await client.query(`
        INSERT INTO identity_users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) DO NOTHING RETURNING id`, [id, name, email, passwordHash])
      if (inserted.rowCount) await this.issue(client, id, 'registration')
    })
  }

  async resend(input: unknown) {
    const email = normalizeEmail(bodyObject(input).email)
    await transaction(this.pool, async client => {
      const user = await client.query<{ id: string; email_confirmed_at: Date | null }>(
        'SELECT id, email_confirmed_at FROM identity_users WHERE email = $1 FOR UPDATE', [email])
      const candidate = user.rows[0]
      if (!candidate || candidate.email_confirmed_at) return
      const { rows: [counts] } = await client.query<{ recent: boolean; resends: number }>(`
        SELECT coalesce(max(issued_at) > clock_timestamp() - $2 * interval '1 second', false) AS recent,
          count(*) FILTER (WHERE issued_by = 'resend'
            AND issued_at > clock_timestamp() - $3 * interval '1 second')::int AS resends
        FROM identity_email_tokens WHERE user_id = $1 AND purpose = $4`,
      [candidate.id, this.policy.resendSeconds, this.policy.resendWindowSeconds, purpose])
      if (counts.recent || counts.resends >= this.policy.resendLimit) return
      await client.query(`
        UPDATE identity_email_tokens SET invalidated_at = clock_timestamp()
        WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND invalidated_at IS NULL`, [candidate.id, purpose])
      await this.issue(client, candidate.id, 'resend')
    })
  }

  async confirm(input: unknown) {
    const token = bodyObject(input).token
    const invalid = () => new PublicError(400, 'INVALID_TOKEN', 'O link de confirmação é inválido ou foi substituído.')
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid()
    await transaction(this.pool, async client => {
      const hash = hashToken(token)
      const owner = await client.query<{ user_id: string }>(
        'SELECT user_id FROM identity_email_tokens WHERE token_hash = $1 AND purpose = $2', [hash, purpose])
      if (!owner.rows[0]) throw invalid()
      const userId = owner.rows[0].user_id
      const locked = await client.query<{ email_confirmed_at: Date | null }>(
        'SELECT email_confirmed_at FROM identity_users WHERE id = $1 FOR UPDATE', [userId])
      const record = await client.query<{ id: string; consumed_at: Date | null; invalidated_at: Date | null; expired: boolean }>(`
        SELECT id, consumed_at, invalidated_at, expires_at <= clock_timestamp() AS expired
        FROM identity_email_tokens WHERE token_hash = $1 AND purpose = $2 AND user_id = $3`, [hash, purpose, userId])
      const current = record.rows[0]
      if (!current || current.invalidated_at) throw invalid()
      if (current.consumed_at || locked.rows[0]?.email_confirmed_at) {
        throw new PublicError(409, 'TOKEN_USED', 'Este link já foi utilizado.')
      }
      if (current.expired) throw new PublicError(410, 'TOKEN_EXPIRED', 'O link expirou. Solicite um novo e-mail.')
      await client.query('UPDATE identity_users SET email_confirmed_at = clock_timestamp() WHERE id = $1', [userId])
      await client.query('UPDATE identity_email_tokens SET consumed_at = clock_timestamp() WHERE id = $1', [current.id])
    })
  }
}




