import { useState, type FormEvent } from 'react'
import './identity.css'

type Result = { message: string; code?: string }
type Action = 'register' | 'confirm' | 'resend'

export async function sendIdentity(action: Action, fields: Record<string, FormDataEntryValue | null>): Promise<Result> {
  try {
    const response = await fetch('/api/identity/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
      cache: 'no-store',
      redirect: 'error',
    })
    const result = await response.json() as Result
    if (typeof result.message === 'string') return result
  } catch {
    // This page deliberately does not log request data.
  }
  return { code: 'UNAVAILABLE', message: 'Não foi possível acessar o serviço. Tente novamente.' }
}

export function IdentityPage({ path, token }: { path: string; token: string | null }) {
  const register = path === '/cadastro'
  const [phase, setPhase] = useState<Action>(register ? 'register' : token ? 'confirm' : 'resend')
  const [result, setResult] = useState<Result>()
  const [busy, setBusy] = useState(false)
  const complete = result && !result.code
  const canResend = phase !== 'resend' && !busy && (phase === 'register' || !complete)
  const heading = phase === 'register' ? 'Crie sua conta' : phase === 'resend' ? 'Solicite outro link' : 'Confirme seu e-mail'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || complete) return
    const form = event.currentTarget
    const data = new FormData(form)
    setBusy(true)
    setResult(undefined)
    try {
      const fields: Record<string, FormDataEntryValue | null> = phase === 'confirm' ? { token } : phase === 'resend' ? { email: data.get('email') }
        : { name: data.get('name'), email: data.get('email'), password: data.get('password') }
      const reply = await sendIdentity(phase, fields)
      setResult(reply)
      if (!reply.code && phase === 'register') form.reset()
    } finally {
      setBusy(false)
    }
  }

  return <main className="identity-page">
    <div className="identity-top"><a href="/" aria-label="ConciliaPix · Início">
      <img src={import.meta.env.BASE_URL + 'silvera-esmeralda.png'} alt=""/> ConciliaPix</a></div>
    <section className="panel identity-panel" aria-labelledby="identity-title">
      <h1 id="identity-title">{heading}</h1>
      <p>{phase === 'confirm' ? 'Selecione o botão abaixo para concluir a confirmação.'
        : 'Enviaremos um link de confirmação para o endereço informado.'}</p>
      {!complete && <form onSubmit={submit}>
        {phase === 'register' && <label>Nome<input name="name" autoComplete="name" minLength={2} maxLength={120} required/></label>}
        {phase !== 'confirm' && <label>E-mail<input type="email" name="email" autoComplete="email" maxLength={320} required/></label>}
        {phase === 'register' && <label>Senha<input type="password" name="password" aria-label="Senha" autoComplete="new-password"
          minLength={12} maxLength={512} required aria-describedby="password-hint"/><small id="password-hint">Use pelo menos 12 caracteres.</small></label>}
        <button className="button primary" type="submit" disabled={busy}>{busy ? 'Processando…'
          : phase === 'register' ? 'Criar conta' : phase === 'confirm' ? 'Confirmar e-mail' : 'Enviar outro link'}</button>
      </form>}
      {result && <p className={result.code ? 'identity-error' : 'identity-success'} role={result.code ? 'alert' : 'status'}>{result.message}</p>}
      <p><a className="identity-link" href="/entrar">Ir para o login</a></p>
      {canResend && <button className="button outline" onClick={() => { setResult(undefined); setPhase('resend') }}>Solicitar outro link</button>}
    </section>
  </main>
}



