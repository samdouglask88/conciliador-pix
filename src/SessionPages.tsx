import { useRef, useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import { sendIdentity } from './IdentityPage'
import './identity.css'

type ErrorReply = { code: string; message: string }
const offline = { code: 'UNAVAILABLE', message: 'Não foi possível acessar o serviço. Tente novamente.' }

async function sessionRequest(path: 'login', body?: Record<string, string>) {
  const response = await fetch('/api/identity/' + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    ...(body ? { headers: { 'Content-Type': 'application/json', 'X-ConciliaPix-CSRF': '1' }, body: JSON.stringify(body) } : {}),
  })
  return response
}

async function sessionError(response: Response): Promise<ErrorReply> {
  const error = await response.json() as Partial<ErrorReply>
  return typeof error.message === 'string' && typeof error.code === 'string' ? error as ErrorReply : offline
}

const chargeAmount = 35_000
const previewCurrency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const formatPreviewAmount = (cents: number) => previewCurrency.format(cents / 100)
const reconciliationExamples = [
  { kind: 'settled', received: chargeAmount, result: 'Conciliado' },
  { kind: 'review', received: 34_500, result: 'Em revisão' },
] as const

function ReconciliationPreview() {
  const [paused, setPaused] = useState(false)
  return <aside className="login-visual" aria-labelledby="login-product-title">
    <div className="login-product">
      <header className="login-product-intro">
        <h2 id="login-product-title">Cada Pix recebido. <span>Cada cobrança conferida.</span></h2>
        <p>Concilie pagamentos e identifique divergências em um só lugar.</p>
      </header>
      <figure className="login-flow">
        <figcaption>
          <span>Veja como funciona</span>
          <button className="login-motion-toggle" type="button" onClick={() => setPaused(value => !value)}>
            {paused ? 'Retomar animação' : 'Pausar animação'}
          </button>
        </figcaption>
        <ul className="login-flow-list" data-paused={paused}>
          {reconciliationExamples.map(example => (
            <li className={'login-reconciliation ' + example.kind} key={example.kind}>
              <div className="login-step">
                <span><Icon name="receipt" size={15}/> Cobrança</span>
                <strong>{formatPreviewAmount(chargeAmount)}</strong>
              </div>
              <div className="login-lane" aria-hidden="true"><span/><Icon name="right" size={13}/></div>
              <div className="login-step">
                <span><Icon name="diagonal" size={15}/> Pix recebido</span>
                <strong>{formatPreviewAmount(example.received)}</strong>
              </div>
              <div className="login-lane result-lane" aria-hidden="true"><span/><Icon name="right" size={13}/></div>
              <div className="login-outcome">
                <strong>
                  <Icon name={example.kind === 'settled' ? 'circleCheck' : 'alert'} size={16}/>
                  {example.result}
                </strong>
                <small>{example.kind === 'settled'
                  ? 'Baixa registrada'
                  : 'Recebido a menos: ' + formatPreviewAmount(chargeAmount - example.received)}</small>
              </div>
            </li>
          ))}
        </ul>
      </figure>
    </div>
  </aside>
}
export function LoginPage() {
  const [showPassword, setShowPassword] = useState(false)
  const passwordInput = useRef<HTMLInputElement>(null)
  const submissionInFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState<ErrorReply>()
  const [resendEmail, setResendEmail] = useState('')
  const [resendNotice, setResendNotice] = useState<{ message: string; code?: string }>()
  const expired = new URLSearchParams(window.location.search).get('sessao') === 'expirada'

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submissionInFlight.current || resending) return
    const form = event.currentTarget
    const data = new FormData(form)
    const email = String(data.get('email') ?? '')
    submissionInFlight.current = true
    setBusy(true)
    setError(undefined)
    setResendNotice(undefined)
    try {
      const response = await sessionRequest('login', { email, password: String(data.get('password') ?? '') })
      if (response.status === 204) {
        form.reset()
        window.location.replace('/app')
        return
      }
      const issue = await sessionError(response)
      if (issue.code === 'EMAIL_UNCONFIRMED') {
        setResendEmail(email)
        const password = form.elements.namedItem('password')
        if (password instanceof HTMLInputElement) password.value = ''
      }
      setError(issue)
    } catch {
      setError(offline)
    } finally {
      submissionInFlight.current = false
      setBusy(false)
    }
  }

  async function resend() {
    if (resending) return
    setResending(true)
    setResendNotice(undefined)
    try { setResendNotice(await sendIdentity('resend', { email: resendEmail })) }
    finally { setResending(false) }
  }

  return <main className="login-page">
    <section className="login-access" aria-labelledby="login-title">
      <a className="login-wordmark" href="/" aria-label="ConciliaPix · Demonstração">
        <img src={import.meta.env.BASE_URL + 'silvera-esmeralda.png'} alt=""/>
        <span>ConciliaPix</span>
      </a>
      <div className="login-content">
        <h1 id="login-title">Entrar</h1>
        <p className="login-description">Acesse sua conta no ConciliaPix.</p>
        {expired && <p className="login-notice" role="status">Sua sessão expirou. Entre novamente.</p>}
        <form onSubmit={login} aria-busy={busy}>
          <div className="login-field">
            <label htmlFor="login-email">E-mail</label>
            <input id="login-email" name="email" type="email" autoComplete="username" maxLength={320} required/>
          </div>
          <div className="login-field">
            <div className="login-field-caption">
              <label htmlFor="login-password">Senha</label>
              <a className="identity-link" href="/recuperar-senha">Esqueci minha senha</a>
            </div>
            <div className="login-password-field">
              <input ref={passwordInput} id="login-password" name="password" type={showPassword ? 'text' : 'password'}
                autoComplete="current-password" maxLength={512} required/>
              <button type="button" aria-controls="login-password"
                onMouseDown={event => {
                  if (document.activeElement === passwordInput.current) event.preventDefault()
                }}
                onClick={() => setShowPassword(value => !value)}>
                {showPassword ? 'Ocultar' : 'Mostrar'}<span className="login-sr-only"> senha</span>
              </button>
            </div>
          </div>
          <button className="button primary login-submit" type="submit" disabled={busy || resending}>
            {busy && <span className="login-spinner" aria-hidden="true"/>}
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        <div className="login-feedback">
          {error && <p className="identity-error" role="alert">{error.message}</p>}
        </div>
        {error?.code === 'EMAIL_UNCONFIRMED' && <>
          <button type="button" className="button outline" disabled={resending || busy} onClick={resend}>
            {resending ? 'Solicitando…' : 'Reenviar confirmação'}
          </button>
          {resendNotice && <p className={resendNotice.code ? 'identity-error' : 'identity-success'}
            role={resendNotice.code ? 'alert' : 'status'}>{resendNotice.message}</p>}
        </>}
      </div>
      <footer className="login-links">
        <p>Primeiro acesso? <a className="identity-link" href="/cadastro">Criar uma conta</a></p>
        <a className="login-demo" href="/">Ver demonstração <Icon name="diagonal" size={14}/></a>
      </footer>
    </section>
    <ReconciliationPreview/>
  </main>
}
