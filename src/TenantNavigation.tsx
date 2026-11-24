import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Icon, type IconName } from './Icon'

export type TenantLink = { id: string; label: string; icon: IconName }
type Group = { label: string; links: TenantLink[]; secondary?: boolean }
type Props = {
  groups: Group[]
  active: string
  hrefFor: (page: string) => string
  onNavigate: (page: string) => void
}

export function TenantNavigation({ groups, active, hrefFor, onNavigate }: Props) {
  const [pinned,setPinned]=useState(()=>{
    try{return localStorage.getItem('conciliapix.sidebar-pinned')==='true'}catch{return false}
  })
  function togglePin(){
    const next=!pinned
    setPinned(next)
    try{localStorage.setItem('conciliapix.sidebar-pinned',String(next))}catch{}
  }
  const drawer = useRef<HTMLDialogElement>(null)
  useEffect(()=>{
    const desktop=matchMedia('(min-width: 901px) and (hover: hover) and (pointer: fine)')
    function closeOnDesktop(){if(desktop.matches) drawer.current?.close()}
    desktop.addEventListener('change',closeOnDesktop)
    return ()=>desktop.removeEventListener('change',closeOnDesktop)
  },[])

  function follow(event: MouseEvent<HTMLAnchorElement>, page: string) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    drawer.current?.close()
    onNavigate(page)
  }

  const logo = <img src={import.meta.env.BASE_URL + 'silvera-esmeralda.png'} alt=""/>
  const brand = <a className="tenant-brand" aria-label="ConciliaPix" href={hrefFor('visao')} onClick={event=>follow(event,'visao')}>
    {logo}<span className="tenant-nav-label">ConciliaPix</span>
  </a>
  const links = <nav className="tenant-nav" aria-label="Navegação principal">
    {groups.filter(group=>group.links.length>0).map(group=><section key={group.label} data-secondary={group.secondary||undefined}>
      <h2>{group.label}</h2>
      <ul>{group.links.map(link=><li key={link.id}>
        <a href={hrefFor(link.id)} aria-label={link.label} aria-current={active===link.id?'page':undefined} onClick={event=>follow(event,link.id)}>
          <Icon name={link.icon} size={19}/><span className="tenant-nav-label">{link.label}</span>
        </a>
      </li>)}</ul>
    </section>)}
  </nav>

  return <>
    <div className="tenant-sidebar-slot" data-pinned={pinned}>
      <aside className="tenant-sidebar">{brand}{links}
        <button type="button" className="tenant-pin" aria-label="Fixar navegação aberta" aria-pressed={pinned} onClick={togglePin}>
          <Icon name="pin" size={19}/><span className="tenant-nav-label">{pinned?'Desafixar menu':'Fixar menu'}</span>
        </button>
      </aside>
    </div>
    <div className="tenant-mobile-bar">{brand}
      <button type="button" className="button outline" aria-label="Abrir menu de navegação" aria-haspopup="dialog"
        aria-controls="tenant-navigation-drawer" onClick={()=>drawer.current?.showModal()}><Icon name="menu"/></button>
    </div>
    <dialog ref={drawer} className="tenant-drawer" id="tenant-navigation-drawer" aria-labelledby="tenant-drawer-title"
      onClick={event=>{if(event.target===event.currentTarget)event.currentTarget.close()}}>
      <div className="tenant-drawer-content">
        <header><h2 id="tenant-drawer-title">Menu</h2><button type="button" className="button outline" aria-label="Fechar menu"
          autoFocus onClick={()=>drawer.current?.close()}><Icon name="close"/></button></header>
        {links}
      </div>
    </dialog>
  </>
}
