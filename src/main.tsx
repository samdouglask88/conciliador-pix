/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client'
import { TenantApp,TenantTransport } from './TenantApp'
import { AccessLinkPage } from './AccessLinkPage'
import { demoApi } from './demo-api'
import { IdentityPage } from './IdentityPage'
import { LoginPage } from './SessionPages'
import './styles.css'

const path = window.location.pathname.replace(/\/$/, '')
const root = createRoot(document.getElementById('root')!)
if (['/confirmar-email','/redefinir-senha','/aceitar-convite'].includes(path)) {
  let revision = 0
  function openConfirmation() {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token')
    if (window.location.hash) window.history.replaceState(null, '', path)
    const key=revision++
    root.render(path==='/confirmar-email'?<IdentityPage key={key} path={path} token={token}/>
      :<AccessLinkPage key={key} mode={path==='/aceitar-convite'?'invite':'reset'} token={token}/>)
  }
  window.addEventListener('hashchange', openConfirmation)
  openConfirmation()
} else if (path==='/app'||path==='/conta') {
  root.render(<TenantApp/>)
} else if (path==='/recuperar-senha') {
  root.render(<AccessLinkPage mode="reset" token={null}/>)
} else if (path === '/entrar') {
  root.render(<LoginPage/>)
} else {
  root.render(path === '/cadastro' ? <IdentityPage path={path} token={null}/> : <TenantTransport.Provider value={{request:demoApi,demo:true}}><TenantApp/></TenantTransport.Provider>)
}


