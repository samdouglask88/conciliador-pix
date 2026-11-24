import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
export const requestId = new AsyncLocalStorage<string>()
export function audit(db: PoolClient, company: string | null, actor: string, action: string, target: string, outcome = 'ok') {
  return db.query('INSERT INTO tenant_audit(company_id,actor,action,target,outcome,correlation) VALUES($1,$2,$3,$4,$5,$6)',
    [company, actor, action, target, outcome, requestId.getStore() ?? randomUUID()])
}
