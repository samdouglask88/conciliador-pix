import { useState,type FormEvent } from 'react'
import { api,message } from './tenant-api'
import './identity.css'

export function AccessLinkPage({mode,token}:{mode:'reset'|'invite';token:string|null}){
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState(false)
  const invite=mode==='invite'
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault()
    if(busy) return
    setBusy(true);setError('');setNotice('')
    const fields=new FormData(event.currentTarget)
    try {
      if(invite){
        const accepted=await api<{companyId:string}>('tenant/invites/accept',{token})
        window.location.replace('/app?empresa='+encodeURIComponent(accepted.companyId))
      }else if(token){
        await api('identity/password/reset',{token,password:fields.get('password')})
        setNotice('Senha redefinida. Entre com sua nova senha.')
      }else{
        const result=await api<{message:string}>('identity/password/request',{email:fields.get('email')})
        setNotice(result.message)
      }
    }catch(error){setError(message(error))}
    finally{setBusy(false)}
  }
  return <main className="identity-page">
    <header className="identity-top"><a href="/entrar"><img src="/silvera-esmeralda.png" alt=""/>ConciliaPix</a></header>
    <section className="panel identity-panel">
      <h1>{invite?'Aceitar convite':token?'Redefinir senha':'Recuperar senha'}</h1>
      {invite&&<p>Entre com o e-mail confirmado que recebeu o convite. Você pode concluir o cadastro e o login em outra aba e retornar aqui.</p>}
      {invite&&!token?<p role="alert">Abra novamente o link original do convite no e-mail.</p>:!notice&&<form onSubmit={submit}>
        {!invite&&(token?<label>Nova senha<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={512} required/></label>
          :<label>E-mail<input name="email" type="email" autoComplete="email" required/></label>)}
        <button className="button primary" disabled={busy}>{busy?'Processando…':invite?'Aceitar convite':token?'Salvar nova senha':'Enviar link de recuperação'}</button>
      </form>}
      {error&&<p className="identity-error" role="alert">{error}</p>}
      {notice&&<p className="identity-success" role="status">{notice}</p>}
      <p><a className="identity-link" href="/entrar" target={invite?'_blank':undefined} rel="noreferrer">Entrar</a></p>
      {invite&&<p><a className="identity-link" href="/cadastro" target="_blank" rel="noreferrer">Criar conta</a></p>}
      {!invite&&token&&error&&<p><a className="identity-link" href="/recuperar-senha">Solicitar outro link</a></p>}
    </section>
  </main>
}
