import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'

export function TenantModal({title,close,children,wide=false}:{title:string;close:()=>void;children:ReactNode;wide?:boolean}){
  const dialog=useRef<HTMLDialogElement>(null)
  const heading=useId()
  useEffect(()=>{
    const element=dialog.current!
    const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null
    element.showModal()
    element.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
    return ()=>{
      if(element.open) element.close()
      if(trigger?.isConnected) trigger.focus({preventScroll:true})
      else (document.querySelector<HTMLElement>('.tenant-heading .button')??document.getElementById('tenant-content'))?.focus({preventScroll:true})
    }
  },[])
  function requestClose(){if(!dialog.current?.querySelector('[aria-busy=true]'))close()}
  return <dialog className="tenant-modal" data-wide={wide} ref={dialog} aria-labelledby={heading}
    onCancel={event=>{event.preventDefault();requestClose()}} onClick={event=>{if(event.target===event.currentTarget)requestClose()}}>
    <div className="tenant-modal-body">
      <header><h2 id={heading}>{title}</h2>
        <button type="button" className="button outline" aria-label="Fechar" onClick={requestClose}><Icon name="close" size={18}/></button>
      </header>
      {children}
    </div>
  </dialog>
}

export function TenantEmpty({icon,title,description,action}:{icon:Parameters<typeof Icon>[0]['name'];title:string;description:string;action?:ReactNode}){
  return <div className="tenant-empty-state">
    <span className="tenant-company-icon"><Icon name={icon} size={22}/></span>
    <h2>{title}</h2><p>{description}</p>{action}
  </div>
}

export function TenantPager({page,more,change}:{page:number;more:boolean;change:(page:number)=>void}){
  return page===1&&!more?null:<div className="tenant-inline pager">
    <button className="button outline" disabled={page===1} onClick={()=>change(page-1)}>Anterior</button>
    <span>Página {page}</span><button className="button outline" disabled={!more} onClick={()=>change(page+1)}>Próxima</button>
  </div>
}
