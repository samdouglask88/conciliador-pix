import { hash, verify } from 'argon2'
import type { Pool, PoolClient } from 'pg'
import { audit } from './audit'
import { transaction } from './db'
import { bodyObject, normalizeEmail, passwordHashOptions, PublicError } from './identity'
import { enqueueToken } from './mail-token'
import { ConfirmationTokens, hashToken } from './tokens'
import { sessionIdPattern } from './sessions'

export function validPassword(value: unknown) {
  if (typeof value !== 'string' || [...value].length < 12 || Buffer.byteLength(value) > 512) {
    throw new PublicError(400,'INVALID_PASSWORD','Informe uma senha com pelo menos 12 caracteres e até 512 bytes.')
  }
  return value
}

export class Account {
  constructor(private pool: Pool, private keys: ConfirmationTokens) {}
  async requestReset(input: unknown) {
    const email = normalizeEmail(bodyObject(input).email)
    await transaction(this.pool, async db => {
      const { rows: [user] } = await db.query<{ id: string }>('SELECT id FROM identity_users WHERE email=$1 FOR UPDATE',[email])
      if (!user) return
      const { rows: [limit] } = await db.query(`SELECT count(*) FILTER(WHERE issued_at>clock_timestamp()-interval '1 hour')::int AS hits,
        coalesce(max(issued_at)>clock_timestamp()-interval '1 minute',false) AS recent
        FROM identity_email_tokens WHERE user_id=$1 AND purpose='reset_password'`,[user.id])
      if (limit.recent || limit.hits >= 5) return
      await this.invalidate(db,user.id)
      await enqueueToken(db,this.keys,'reset_password',{user:user.id},1800)
      await audit(db,null,user.id,'password.reset_requested',user.id)
    })
  }
  private invalidate(db: PoolClient,user: string) {
    return db.query(`UPDATE identity_email_tokens SET invalidated_at=clock_timestamp()
      WHERE user_id=$1 AND purpose='reset_password' AND consumed_at IS NULL AND invalidated_at IS NULL`,[user])
  }
  private async replace(db: PoolClient,user: string,passwordHash: string) {
    await db.query('UPDATE identity_users SET password_hash=$2,password_version=password_version+1 WHERE id=$1',[user,passwordHash])
    await db.query('UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL',[user])
    await this.invalidate(db,user)
  }
  async reset(input: unknown) {
    const fields = bodyObject(input)
    const invalid = () => new PublicError(400,'INVALID_TOKEN','O link é inválido ou foi substituído.')
    if (typeof fields.token !== 'string' || !sessionIdPattern.test(fields.token)) throw invalid()
    const tokenHash = hashToken(fields.token)
    const password = validPassword(fields.password)
    const { rows: [owner] } = await this.pool.query<{ user_id: string }>(
      "SELECT user_id FROM identity_email_tokens WHERE token_hash=$1 AND purpose='reset_password'",[tokenHash])
    if (!owner) throw invalid()
    const passwordHash = await hash(password,passwordHashOptions)
    await transaction(this.pool,async db => {
      await db.query('SELECT id FROM identity_users WHERE id=$1 FOR UPDATE',[owner.user_id])
      const { rows: [token] } = await db.query(`SELECT id,consumed_at,invalidated_at,expires_at<=clock_timestamp() AS expired
        FROM identity_email_tokens WHERE token_hash=$1 AND purpose='reset_password'`,[tokenHash])
      if (!token || token.invalidated_at) throw invalid()
      if (token.consumed_at) throw new PublicError(409,'TOKEN_USED','Este link já foi utilizado.')
      if (token.expired) throw new PublicError(410,'TOKEN_EXPIRED','O link expirou. Solicite outro.')
      await db.query('UPDATE identity_email_tokens SET consumed_at=clock_timestamp() WHERE id=$1',[token.id])
      await this.replace(db,owner.user_id,passwordHash)
      await audit(db,null,owner.user_id,'password.reset',owner.user_id)
    })
  }
  async change(user: string, token: string, input: unknown) {
    const fields = bodyObject(input)
    const password = validPassword(fields.password)
    const current = fields.currentPassword
    if (typeof current !== 'string' || !current || Buffer.byteLength(current)>512) {
      throw new PublicError(400,'INVALID_INPUT','Informe a senha atual.')
    }
    const { rows: [observed] } = await this.pool.query('SELECT password_hash,password_version FROM identity_users WHERE id=$1',[user])
    if (!observed || !await verify(observed.password_hash,current)) throw new PublicError(401,'INVALID_CREDENTIALS','Senha atual incorreta.')
    const passwordHash = await hash(password,passwordHashOptions)
    await transaction(this.pool,async db => {
      const { rows: [locked] } = await db.query('SELECT password_version FROM identity_users WHERE id=$1 FOR UPDATE',[user])
      const active = await db.query(`SELECT 1 FROM identity_sessions WHERE user_id=$1 AND token_hash=$2 AND revoked_at IS NULL
        AND idle_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()`,[user,hashToken(token)])
      if (locked?.password_version!==observed.password_version || !active.rowCount) throw new PublicError(401,'SESSION_INVALID','Entre novamente.')
      await this.replace(db,user,passwordHash)
      await audit(db,null,user,'password.change',user)
    })
  }
  async updateName(user: string,input: unknown) {
    const name = bodyObject(input).name
    if (typeof name !== 'string' || name.trim().length<2 || name.length>120 || /[\x00-\x1f\x7f]/.test(name)) {
      throw new PublicError(400,'INVALID_NAME','Informe um nome de 2 a 120 caracteres.')
    }
    await transaction(this.pool,async db => {
      await db.query('UPDATE identity_users SET name=$2 WHERE id=$1',[user,name.trim()])
      await audit(db,null,user,'profile.update',user)
    })
  }
  async revokeOthers(user: string,token: string) {
    await transaction(this.pool,async db => {
      await db.query('SELECT id FROM identity_users WHERE id=$1 FOR UPDATE',[user])
      const active=await db.query(`SELECT 1 FROM identity_sessions WHERE user_id=$1 AND token_hash=$2 AND revoked_at IS NULL
        AND idle_expires_at>clock_timestamp() AND absolute_expires_at>clock_timestamp()`,[user,hashToken(token)])
      if(!active.rowCount) throw new PublicError(401,'SESSION_INVALID','Entre novamente.')
      await db.query('UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND token_hash<>$2 AND revoked_at IS NULL',[user,hashToken(token)])
      await audit(db,null,user,'session.revoke_others',user)
    })
  }
}

