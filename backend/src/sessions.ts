import { audit } from './audit'
import { createHmac, randomBytes } from 'node:crypto'
import { hash, verify } from 'argon2'
import type { Pool } from 'pg'
import { transaction } from './db'
import { bodyObject, normalizeEmail, passwordHashOptions, PublicError } from './identity'
import { hashToken } from './tokens'

export const sessionPolicy = { absoluteSeconds: 12 * 3600, idleSeconds: 30 * 60 }
export const sessionIdPattern = /^[A-Za-z0-9_-]{43}$/
export type SessionUser = { id: string; name: string; email: string }
type LoginUser = SessionUser & { password_hash: string; email_confirmed_at: Date | null; password_version: string }

export class Sessions {
  private constructor(private pool: Pool, private rateKey: Buffer, private dummyHash: string) {}

  static async create(pool: Pool, rateKey: Buffer) {
    return new Sessions(pool, rateKey, await hash(randomBytes(32), passwordHashOptions))
  }

  private async limit(kind: 'origin' | 'pair', address: string, email = '') {
    const key = createHmac('sha256', this.rateKey).update(JSON.stringify([kind, address, email])).digest('hex')
    const { rows } = await this.pool.query<{ hits: number }>(`
      INSERT INTO identity_rate_limits AS rate (key, hits, expires_at)
      VALUES ($1, 1, now() + interval '15 minutes')
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN rate.expires_at <= now() THEN 1 ELSE LEAST(rate.hits + 1, 1000000) END,
        expires_at = CASE WHEN rate.expires_at <= now() THEN EXCLUDED.expires_at ELSE rate.expires_at END
      RETURNING hits`, ['login:' + key])
    if (rows[0].hits > (kind === 'origin' ? 30 : 8)) {
      throw new PublicError(429, 'LOGIN_RATE_LIMITED', 'Muitas tentativas. Aguarde antes de tentar novamente.')
    }
  }

  async login(input: unknown, address: string, previousToken?: string) {
    await this.limit('origin', address)
    const fields = bodyObject(input)
    const email = normalizeEmail(fields.email)
    const password = fields.password
    if (typeof password !== 'string' || !password.length || Buffer.byteLength(password) > 512) {
      throw new PublicError(400, 'INVALID_INPUT', 'Informe o e-mail e uma senha válida.')
    }
    await this.limit('pair', address, email)
    const { rows: [user] } = await this.pool.query<LoginUser>(`
      SELECT id, name, email, password_hash, email_confirmed_at, password_version FROM identity_users WHERE email = $1`, [email])
    const valid = await verify(user?.password_hash ?? this.dummyHash, password)
    if (!valid || !user) throw new PublicError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.')
    if (!user.email_confirmed_at) {
      throw new PublicError(403, 'EMAIL_UNCONFIRMED', 'Confirme seu e-mail para entrar.')
    }

    const token = randomBytes(32).toString('base64url')
    await transaction(this.pool, async client => {
      const account = await client.query<{ password_version: string }>(
        'SELECT password_version FROM identity_users WHERE id = $1 FOR UPDATE', [user.id])
      if (account.rows[0]?.password_version !== user.password_version) {
        throw new PublicError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.')
      }
      if (previousToken) {
        const oldHash = hashToken(previousToken)
        const { rows: [previous] } = await client.query<{ replaced: boolean; within_lifetime: boolean }>(`
          SELECT replaced, absolute_expires_at > clock_timestamp() AS within_lifetime
          FROM identity_sessions WHERE token_hash = $1 FOR UPDATE`, [oldHash])
        if (previous?.replaced && previous.within_lifetime) {
          throw new PublicError(409, 'SESSION_REPLACED', 'Outra solicitação já renovou esta sessão. Atualize a página antes de tentar novamente.')
        }
        await client.query(`
          UPDATE identity_sessions SET revoked_at = clock_timestamp(), replaced = true
          WHERE token_hash = $1 AND revoked_at IS NULL`, [oldHash])
      }
      await client.query(`
        INSERT INTO identity_sessions (token_hash, user_id, created_at, absolute_expires_at, idle_expires_at)
        SELECT $1, $2, stamp, stamp + $3 * interval '1 second', stamp + $4 * interval '1 second'
        FROM (SELECT clock_timestamp() AS stamp) AS instant`,
      [hashToken(token), user.id, sessionPolicy.absoluteSeconds, sessionPolicy.idleSeconds])
      await audit(client,null,user.id,'session.login',user.id)
    })
    return token
  }

  async current(token?: string): Promise<SessionUser | undefined> {
    if (!token) return
    const { rows: [user] } = await this.pool.query<SessionUser>(`
      UPDATE identity_sessions AS session
      SET idle_expires_at = LEAST(session.absolute_expires_at, clock_timestamp() + $2 * interval '1 second')
      FROM identity_users AS account
      WHERE session.token_hash = $1 AND session.user_id = account.id AND account.email_confirmed_at IS NOT NULL
        AND session.revoked_at IS NULL AND session.absolute_expires_at > clock_timestamp()
        AND session.idle_expires_at > clock_timestamp()
      RETURNING account.id, account.name, account.email`, [hashToken(token), sessionPolicy.idleSeconds])
    return user
  }

  async logout(token?: string) {
    if (!token) return
    await transaction(this.pool,async db=>{
      const {rows:[revoked]}=await db.query<{user_id:string}>(`UPDATE identity_sessions SET revoked_at=clock_timestamp()
        WHERE token_hash=$1 AND revoked_at IS NULL RETURNING user_id`,[hashToken(token)])
      if(revoked) await audit(db,null,revoked.user_id,'session.logout',revoked.user_id)
    })
  }
}


