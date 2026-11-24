import { createHash, createHmac, randomUUID } from 'node:crypto'

export const purpose = 'confirm_email'
export type TokenPurpose = 'confirm_email' | 'reset_password' | 'invite'
export const hashToken = (value: string) => createHash('sha256').update(value).digest()

export class ConfirmationTokens {
  constructor(readonly activeKey: string, private readonly keys: ReadonlyMap<string, Buffer>) {
    if (!keys.has(activeKey) || [...keys.values()].some(key => key.length < 32)) throw new Error('Chaves de confirmação inválidas.')
  }

  derive(id: string, keyId: string, kind: TokenPurpose = purpose) {
    const key = this.keys.get(keyId)
    if (!key) throw new Error('Chave de confirmação indisponível.')
    return createHmac('sha256', key).update('conciliapix:' + kind + ':v1:' + id).digest('base64url')
  }

  issue(kind: TokenPurpose = purpose) {
    const id = randomUUID()
    return { id, keyId: this.activeKey, hash: hashToken(this.derive(id, this.activeKey, kind)) }
  }
}

