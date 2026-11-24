import type { PoolClient } from 'pg'
import { ConfirmationTokens, type TokenPurpose } from './tokens'
export async function enqueueToken(client: PoolClient, keys: ConfirmationTokens, kind: TokenPurpose,
  target: { user?: string; recipient?: string }, seconds: number) {
  const token = keys.issue(kind)
  await client.query(`INSERT INTO identity_email_tokens(id,user_id,recipient,purpose,token_hash,key_id,issued_by,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'registration',clock_timestamp()+$7*interval '1 second')`,
    [token.id,target.user ?? null,target.recipient ?? null,kind,token.hash,token.keyId,seconds])
  await client.query('INSERT INTO identity_mail_outbox(token_id) VALUES($1)',[token.id])
  return token.id
}
