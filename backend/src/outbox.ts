import type { TokenPurpose } from './tokens'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { ConfirmationTokens } from './tokens'

type Delivery = { to: string; link: URL; purpose: TokenPurpose }
type Job = { token_id: string; key_id: string; email: string; attempts: number; purpose: TokenPurpose }
const maximumAttempts = 5

export class MailOutbox {
  constructor(private pool: Pool, private tokens: ConfirmationTokens, private confirmationUrl: URL,
    private deliver: (mail: Delivery) => Promise<void>) {}

  async processOne() {
    await this.pool.query(`
      UPDATE identity_mail_outbox AS job SET state = 'failed', lease_id = NULL, lease_until = NULL, last_error = 'LEASE_EXPIRED'
      WHERE state = 'sending' AND lease_until <= now() AND attempts >= $1`, [maximumAttempts])
    await this.pool.query(`
      UPDATE identity_mail_outbox AS job SET state = 'cancelled', lease_id = NULL, lease_until = NULL
      FROM identity_email_tokens AS token
      WHERE job.token_id = token.id AND (job.state = 'pending' OR (job.state = 'sending' AND job.lease_until <= now()))
        AND (token.consumed_at IS NOT NULL OR token.invalidated_at IS NOT NULL OR token.expires_at <= now())`)
    const lease = randomUUID()
    const { rows } = await this.pool.query<Job>(`
      WITH ready AS (
        SELECT job.token_id, token.key_id, token.purpose, coalesce(token.recipient, member.email) AS email
        FROM identity_mail_outbox AS job
        JOIN identity_email_tokens AS token ON token.id = job.token_id
        LEFT JOIN identity_users AS member ON member.id = token.user_id
        WHERE (job.state = 'pending' OR (job.state = 'sending' AND job.lease_until <= now()))
          AND job.available_at <= now() AND job.attempts < $2 AND token.expires_at > now()
          AND token.consumed_at IS NULL AND token.invalidated_at IS NULL
        ORDER BY job.available_at, job.token_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
      )
      UPDATE identity_mail_outbox AS job
      SET state = 'sending', attempts = attempts + 1, lease_until = now() + interval '2 minutes', lease_id = $1
      FROM ready WHERE job.token_id = ready.token_id
      RETURNING job.token_id, ready.key_id, ready.purpose, ready.email, job.attempts`, [lease, maximumAttempts])
    const job = rows[0]
    if (!job) return false
    let sent = false
    let failure = 'TOKEN_KEY_UNAVAILABLE'
    try {
      const link = new URL(this.confirmationUrl)
      if (job.purpose !== 'confirm_email') {
        link.pathname = job.purpose === 'invite' ? '/aceitar-convite' : '/redefinir-senha'
      }
      link.hash = 'token=' + this.tokens.derive(job.token_id, job.key_id, job.purpose)
      failure = 'SMTP_DELIVERY_FAILED'
      await this.deliver({ to: job.email, link, purpose: job.purpose })
      sent = true
    } catch {
      // Use only static error categories. Transport errors can include SMTP details.
    }
    if (sent) {
      await this.pool.query(`
        UPDATE identity_mail_outbox SET state = 'sent', sent_at = now(), last_error = NULL, lease_id = NULL, lease_until = NULL
        WHERE token_id = $1 AND lease_id = $2`, [job.token_id, lease])
    } else {
      await this.pool.query(`
        UPDATE identity_mail_outbox SET state = $3, last_error = $4,
          available_at = now() + $5 * interval '1 second', lease_id = NULL, lease_until = NULL
        WHERE token_id = $1 AND lease_id = $2`, [job.token_id, lease,
        job.attempts >= maximumAttempts ? 'failed' : 'pending', failure, 30 * 2 ** (job.attempts - 1)])
    }
    return true
  }

  async recover(tokenId: string) {
    const result = await this.pool.query(`
      UPDATE identity_mail_outbox AS job SET state = 'pending', attempts = 0, available_at = now(), last_error = NULL
      FROM identity_email_tokens AS token
      WHERE job.token_id = $1 AND token.id = job.token_id AND job.state = 'failed' AND token.expires_at > now()
        AND token.consumed_at IS NULL AND token.invalidated_at IS NULL`, [tokenId])
    return result.rowCount === 1
  }
}

