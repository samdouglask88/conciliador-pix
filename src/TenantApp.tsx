import { createContext,useContext,useEffect,useRef,useState,type FormEvent,type ReactNode } from 'react'
import { TenantEmpty,TenantModal,TenantPager } from './TenantUI'
import { Icon } from './Icon'
import { TenantNavigation,type TenantLink } from './TenantNavigation'
import { api,ApiIssue,message } from './tenant-api'
import { Overview,type Dashboard } from './Overview'
import { demoCompany } from './demo-api'
import './tenant.css'

export const TenantTransport=createContext({request:api,demo:false})

type Role='owner'|'admin'|'finance'|'viewer'
type Company={id:string;name:string;role:Role;simulator?:boolean}
type User={id:string;name:string;email:string}
type RoleRecord={id:string;email:string;role:Role;name?:string;active?:boolean;status?:string;expires_at?:string}
type RecordRow={id:string;created_at:string;name?:string;email?:string;description?:string;client_name?:string;amount?:number;
  status?:string;outcome?:string;external_id?:string;external_payment_id?:string;reason?:string;expected?:number|null;received?:number;
  resolution?:string;justification?:string;resolved_by?:string;resolved_at?:string;charge_id?:string;event_id?:string;review_id?:string;
  deliveries?:RecordRow[];payments?:RecordRow[];reviews?:RecordRow[];events?:RecordRow[]}
type RecordKind='clients'|'charges'|'events'|'reviews'
type Rows={items:RecordRow[];page:number;hasMore:boolean}
type Location={company:string;page:string;item:string;filter:string}
const roleNames:Record<Role,string>={owner:'Proprietário',admin:'Administrador',finance:'Financeiro',viewer:'Consulta'}
const captions:Record<string,string>={pending:'Pendente',paid:'Conciliada',settled:'Baixa registrada',extra:'Pagamento extra',
  divergent:'Valor divergente',duplicate:'Reenvio',unmatched:'Sem cobrança',conflict:'Conflito',open:'Em aberto',resolved:'Resolvida',
  close:'Encerrada com justificativa',settle:'Baixa manual',refund_recorded:'Devolução externa registrada',created:'Cobrança criada',accepted:'Aceito',revoked:'Revogado',active:'Ativo',inactive:'Inativo'}
const pages:TenantLink[]=[
  {id:'visao',label:'Visão geral',icon:'grid'},{id:'clients',label:'Clientes',icon:'people'},
  {id:'charges',label:'Cobranças',icon:'receipt'},{id:'reviews',label:'Revisões',icon:'alert'},
  {id:'events',label:'Eventos',icon:'history'},{id:'simulator',label:'Simulador',icon:'flask'},
  {id:'profile',label:'Perfil',icon:'store'},{id:'security',label:'Segurança',icon:'circleCheck'},
  {id:'company',label:'Empresa',icon:'store'},{id:'team',label:'Equipe',icon:'people'},
]
const accountPages=['profile','security']
const realFormatter=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'})
const money=(value:number|string|null|undefined)=>value==null?'—':realFormatter.format(Number(value)/100)
const date=(value?:string)=>value?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(new Date(value)):'—'
const title=(value?:string)=>value?captions[value]??value:'—'
function readLocation(demo:boolean):Location{
  const query=new URLSearchParams(window.location.search)
  const legacy:Record<string,string>={cobrancas:'charges',revisoes:'reviews',eventos:'events',simulador:'simulator'}
  return {company:demo?demoCompany:query.get('empresa')??'',page:query.get('pagina')??(demo?legacy[window.location.hash.slice(1)]??'visao':'visao'),
    item:query.get('item')??'',filter:query.get('filtro')??''}
}
function useRemote<T>(path:string,revision=0,background=false):{data?:T;error?:string;loading?:boolean;retry?:()=>void}{
  const {request}=useContext(TenantTransport)
  const [attempt,retry]=useState(0)
  const [response,setResponse]=useState<{path:string;revision:number;data?:T;error?:string}>()
  useEffect(()=>{
    if(!path) return
    let current=true
    request<T>(path).then(data=>{if(current)setResponse({path,revision,data})}).catch(error=>{
      if(!current)return
      if(error instanceof ApiIssue&&error.status===401){window.location.replace('/entrar?sessao=expirada');return}
      setResponse({path,revision,error:message(error)})
    })
    return()=>{current=false}
  },[path,revision,attempt,request])
  return response?.path===path&&(response.revision===revision||background&&!response.error)?{...response,retry:()=>{setResponse(undefined);retry(value=>value+1)}}:{loading:Boolean(path)}
}
function Result<T>({state,children}:{state:{data?:T;error?:string;loading?:boolean;retry?:()=>void};children:(data:T)=>ReactNode}){
  if(state.error)return <div className="tenant-error" role="alert"><Icon name="alert" size={18}/><span>{state.error}</span>
    {state.retry&&<button className="button outline" onClick={state.retry}>Tentar novamente</button>}</div>
  if(state.loading)return <p className="tenant-loading" role="status">Carregando…</p>
  return state.data===undefined?null:children(state.data)
}
function useMutation(){
  const [busy,setBusy]=useState(false)
  const inFlight=useRef(false)
  const [feedback,setFeedback]=useState<{text:string;error?:boolean}>()
  async function run(work:()=>Promise<void>){
    if(inFlight.current)return
    inFlight.current=true
    setFeedback(undefined);setBusy(true)
    try{await work();setFeedback({text:'Operação concluída.'})}
    catch(error){
      if(error instanceof ApiIssue&&error.status===401&&error.message.startsWith('Entre')){
        window.location.replace('/entrar?sessao=expirada');return
      }
      setFeedback({text:message(error),error:true})
    }finally{inFlight.current=false;setBusy(false)}
  }
  return {run,busy,feedback,clear:()=>setFeedback(undefined),announce:()=>setFeedback({text:'Operação concluída.'})}
}
function Feedback({value}:{value?:{text:string;error?:boolean}}){
  return value?<p className={value.error?'tenant-error':'tenant-ok'} role={value.error?'alert':'status'}>
    <Icon name={value.error?'alert':'circleCheck'} size={18}/>{value.text}
  </p>:null
}
function Heading({name,description,action}:{name:string;description:string;action?:ReactNode}){
  return <header className="tenant-heading"><div><h1>{name}</h1><p>{description}</p></div>{action}</header>
}
function NewRecordButton({children,onClick}:{children:ReactNode;onClick:()=>void}){
  return <button className="button primary" type="button" onClick={onClick}><Icon name="plus" size={17}/>{children}</button>
}
function formData(event:FormEvent<HTMLFormElement>){
  event.preventDefault()
  return new FormData(event.currentTarget)
}

export function TenantApp(){
  const {request:api,demo}=useContext(TenantTransport)
  const [location,setLocation]=useState(()=>readLocation(demo))
  const [revision,setRevision]=useState(0)
  const user=useRemote<{user:User}>('identity/session',revision,true)
  const companies=useRemote<Company[]>(user.data?'tenant/companies':'',revision,true)
  const selected=useRemote<Company>(user.data&&location.company?'tenant/companies/'+encodeURIComponent(location.company):'',revision,true)
  const update=()=>setRevision(value=>value+1)
  const logout=useMutation()
  const accountMenu=useRef<HTMLDetailsElement>(null)
  const content=useRef<HTMLElement>(null)
  const createKey=useRef<{name:string;key:string}|undefined>(undefined)
  useEffect(()=>{
    const restore=()=>setLocation(readLocation(demo))
    function restoreFromCache(event:PageTransitionEvent){ if(event.persisted)setRevision(value=>value+1) }
    function recheck(){ if(document.visibilityState==='visible')setRevision(value=>value+1) }
    window.addEventListener('popstate',restore)
    if(demo)window.addEventListener('hashchange',restore)
    window.addEventListener('pageshow',restoreFromCache)
    document.addEventListener('visibilitychange',recheck)
    return()=>{
      window.removeEventListener('popstate',restore)
      if(demo)window.removeEventListener('hashchange',restore)
      window.removeEventListener('pageshow',restoreFromCache)
      document.removeEventListener('visibilitychange',recheck)
    }
  },[demo])
  function navigate(page:string,company=location.company,item='',filter=''){
    const query=new URLSearchParams()
    if(company&&!demo)query.set('empresa',company)
    if(page!=='visao')query.set('pagina',page)
    if(item)query.set('item',item)
    if(filter)query.set('filtro',filter)
    const target=(demo?'/':'/app')+(query.size?'?'+query:'')
    if(window.location.pathname+window.location.search!==target) window.history.pushState(null,'',target)
    setLocation({company,page,item,filter})
    if(page!==location.page||company!==location.company){
      window.scrollTo(0,0)
      if(!item)content.current?.focus({preventScroll:true})
    }
  }
  function open(kind:string,id:string){navigate(kind,location.company,id,kind===location.page?location.filter:'')}
  const company=selected.data
  const operate=Boolean(company&&company.role!=='viewer')
  const manage=!demo&&(company?.role==='owner'||company?.role==='admin')
  const groups=company?[
    {label:'Operação',links:pages.filter(page=>['visao','clients','charges','reviews'].includes(page.id))},
    {label:'Administração',links:demo?[]:pages.filter(page=>page.id==='company'||page.id==='team'&&manage)},
    {label:'Ferramentas técnicas',secondary:true,links:pages.filter(page=>page.id==='events'||page.id==='simulator'&&company.simulator&&operate)},
  ]:[{label:'Ambiente de trabalho',links:location.company?[]:[{id:'visao',label:'Empresas',icon:'grid' as const}]}]
  const apiRoot='tenant/companies/'+encodeURIComponent(location.company)
  const currentArea=location.page==='visao'&&!location.company?'Empresas':pages.find(page=>page.id===location.page)?.label
  return <div className="tenant-shell">
    <a className="skip" href="#tenant-content">Pular para o conteúdo</a>
    <TenantNavigation groups={groups} active={location.page}
      hrefFor={page=>(demo?'/?':'/app?')+new URLSearchParams(demo?{pagina:page}:{empresa:location.company,pagina:page})} onNavigate={page=>navigate(page)}/>
    <main id="tenant-content" tabIndex={-1} ref={content}>
      <header className="tenant-header">
        <div className="tenant-topbar">
          <div className="tenant-context">
            {demo?<strong>Loja demonstração</strong>:<label className="tenant-switch"><Icon name="store" size={17}/><span>Empresa ativa</span>
              <select aria-label="Empresa ativa" value={location.company} disabled={!companies.data} onChange={event=>navigate('visao',event.target.value)}>
                <option value="">Selecionar empresa</option>
                {companies.data?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>}
            <span className="tenant-context-area">{currentArea}</span>
          </div>
          {demo&&<div className="tenant-demo-actions"><span className="demo"><i/> Ambiente demo · Dados fictícios</span><a className="button outline" href="/entrar">Entrar</a></div>}
          {!demo&&user.data&&<details className="tenant-account" ref={accountMenu} onKeyDown={event=>{
            if(event.key==='Escape'&&event.currentTarget.open){
              event.currentTarget.open=false
              event.currentTarget.querySelector('summary')?.focus()
            }
          }}>
            <summary aria-label={'Menu da conta de '+user.data.user.name}><span className="tenant-avatar" aria-hidden="true">{user.data.user.name.slice(0,1).toUpperCase()}</span>
              <span className="tenant-account-name">{user.data.user.name}</span><span className="tenant-account-caret"><Icon name="right" size={14}/></span>
            </summary>
            <div className="tenant-account-menu">
              <p>{user.data.user.email}</p>
              <nav aria-label="Conta">
                {accountPages.map(page=><a key={page} href={'/app?'+new URLSearchParams({empresa:location.company,pagina:page})}
                  aria-current={location.page===page?'page':undefined} onClick={event=>{
                    if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return
                    event.preventDefault()
                    if(accountMenu.current)accountMenu.current.open=false
                    navigate(page)
                  }}>{pages.find(item=>item.id===page)?.label}</a>)}
              </nav>
              <button className="button outline" disabled={logout.busy} onClick={()=>logout.run(async()=>{
                await api('identity/logout',{});window.location.replace('/entrar')
              })}>{logout.busy?'Saindo…':'Sair'}</button>
              <Feedback value={logout.feedback}/>
            </div>
          </details>}
        </div>
      </header>
      <div className={'workspace tenant-workspace'+(!location.company?' tenant-entry':'')}>
        <Result state={user}>{({user:person})=><>
          {!demo&&location.page==='profile'?<Personal user={person} update={update}/>:!demo&&location.page==='security'?<Security/>:
          !location.company?<CompanyDirectory revision={revision} choose={id=>navigate('visao',id)} create={async name=>{
            if(createKey.current?.name!==name)createKey.current={name,key:crypto.randomUUID()}
            const created=await api<{id:string}>('tenant/companies',{name,requestKey:createKey.current.key})
            createKey.current=undefined
            update()
            navigate('visao',created.id)
          }}/>
          :<Result state={selected}>{active=><>
            {location.page==='visao'?<Summary key={active.id} root={apiRoot} operate={operate} open={open} filter={(page,filter)=>navigate(page,location.company,'',filter)}/>:
              !demo&&location.page==='company'?<CompanyPage item={active} root={apiRoot} manage={manage} update={update}/>:
              location.page==='team'&&manage?<Team key={active.id} root={apiRoot} role={active.role}/>:
              location.page==='simulator'&&active.simulator&&operate?<Simulation key={active.id+location.item} root={apiRoot} initial={location.item} open={open}/>:
              ['clients','charges','events','reviews'].includes(location.page)
                ?<Records key={active.id+location.page+location.filter} root={apiRoot} kind={location.page as RecordKind} item={location.item} initialFilter={location.filter}
                  operate={operate} open={open} close={()=>navigate(location.page,location.company,'',location.filter)} simulator={Boolean(active.simulator)}/>
                :<p role="alert">Esta página não está disponível para seu papel.</p>}
          </>}</Result>}
        </>}</Result>
      </div>
    </main>
  </div>
}

function Summary({root,operate,open,filter}:{root:string;operate:boolean;open:(kind:string,id:string)=>void;filter:(page:string,key:string)=>void}){
  const [period,setPeriod]=useState<7|30>(7)
  const summary=useRemote<Dashboard>(root+'/overview?days=7')
  const extended=useRemote<Dashboard>(period===30?root+'/overview?days=30':'')
  const queue=useRemote<Rows>(root+'/reviews?filter=open&page=1')
  const data=summary.data
  const empty=data&&!data.activity.length&&!data.series.length&&!data.paidCount&&!data.pendingCount&&!data.reviews
  return <Overview summary={data} period={period} setPeriod={setPeriod} periodData={period===7?data:extended.data}
    queue={queue.data?.items} summaryState={!data&&<Result state={summary}>{()=>null}</Result>}
    periodState={period===30&&!extended.data?<Result state={extended}>{()=>null}</Result>:undefined}
    queueState={!queue.data?<Result state={queue}>{()=>null}</Result>:undefined}
    label={title} onFilter={filter} onOpen={open}
    action={operate&&<NewRecordButton onClick={()=>open('charges','novo')}>Nova cobrança</NewRecordButton>}
    onboard={empty&&<section className="tenant-first-steps"><div><h2>Comece a operar nesta empresa</h2>
      <p>{operate?'Cadastre um cliente ou crie uma cobrança para começar a acompanhar os pagamentos.':'Os dados aparecem quando a empresa tiver movimentações.'}</p></div>
      {operate&&<button className="button outline" onClick={()=>open('clients','novo')}><Icon name="plus" size={16}/>Cadastrar cliente</button>}
    </section>}/>
}

const recordNames:Record<RecordKind,string>={clients:'Clientes',charges:'Cobranças',events:'Eventos',reviews:'Revisões'}
const recordDescription:Record<RecordKind,string>={
  clients:'Consulte os clientes cadastrados e vincule-os às cobranças.',
  charges:'Acompanhe os valores e a situação das cobranças Pix.',
  events:'Consulte as notificações recebidas pelo webhook e o resultado do processamento.',
  reviews:'Investigue divergências e acompanhe as decisões de conciliação.',
}
const filters:Partial<Record<RecordKind,string[]>>={charges:['pending','paid'],events:['settled','divergent','extra','duplicate','unmatched','conflict'],reviews:['open','resolved']}
const recordPresentation={
  clients:{search:'Nome ou e-mail',filter:'',column:'Cliente',icon:'people',empty:'Cadastre seu primeiro cliente',help:'Cadastre os dados de contato para identificar e vincular o cliente às cobranças.'},
  charges:{search:'Descrição, cliente ou ID',filter:'Situação da cobrança',column:'Cobrança',icon:'receipt',empty:'Nenhuma cobrança registrada',help:'Crie uma cobrança para começar a acompanhar os pagamentos.'},
  reviews:{search:'ID da revisão ou da cobrança',filter:'Situação da revisão',column:'Divergência',icon:'alert',empty:'Nenhuma divergência para revisar',help:'Pagamentos que exigirem conferência aparecerão aqui.'},
  events:{search:'ID do evento, pagamento ou cobrança',filter:'Resultado do processamento',column:'Evento',icon:'history',empty:'Nenhum evento recebido',help:'As notificações recebidas e processadas pelo webhook aparecerão aqui.'},
} as const

function Records({root,kind,item,initialFilter,operate,open,close,simulator}:{root:string;kind:RecordKind;item:string;initialFilter:string;operate:boolean;
  open:(kind:string,id:string)=>void;close:()=>void;simulator:boolean}){
  const [draft,setDraft]=useState(''),[q,setQuery]=useState(''),[filter,setFilter]=useState(filters[kind]?.includes(initialFilter)?initialFilter:''),[page,setPage]=useState(1),[revision,refresh]=useState(0)
  const query=new URLSearchParams({q,filter,page:String(page)})
  const list=useRemote<Rows>(root+'/'+kind+'?'+query,revision)
  const creatable=operate&&(kind==='clients'||kind==='charges')
  const creating=creatable&&item==='novo'
  const editing=kind==='clients'&&operate&&item.startsWith('editar:')
  const itemId=editing?item.slice('editar:'.length):item
  const detail=useRemote<RecordRow>(itemId&&itemId!=='novo'?root+'/'+kind+'/'+encodeURIComponent(itemId):'',revision,true)
  const changed=()=>refresh(value=>value+1)
  const createLabel=kind==='clients'?'Novo cliente':'Nova cobrança'
  const presentation=recordPresentation[kind]
  const clear=()=>{setDraft('');setQuery('');setFilter('');setPage(1)}
  const create=()=>open(kind,'novo')
  const filtered=Boolean(q||filter)
  const showOpenEmpty=kind==='reviews'&&filter==='open'&&!q
  return <><Heading name={recordNames[kind]} description={recordDescription[kind]}
    action={creatable&&<NewRecordButton onClick={create}>{createLabel}</NewRecordButton>}/>
    <section className="panel tenant-box tenant-register">
      <form className="tenant-inline tenant-filters" onSubmit={event=>{event.preventDefault();setQuery(draft.trim());setPage(1)}}>
        <label>Buscar {recordNames[kind].toLowerCase()}<span className="tenant-search">
          <Icon name="search" size={17}/><input name="q" type="search" maxLength={120} value={draft}
            placeholder={presentation.search} onChange={event=>setDraft(event.target.value)}/>
        </span></label>
        {filters[kind]&&<label>{presentation.filter}<select value={filter} onChange={event=>{setFilter(event.target.value);setPage(1)}}>
          <option value="">Todas as opções</option>{filters[kind]!.map(key=><option key={key} value={key}>{title(key)}</option>)}
        </select></label>}
        <button className="button outline">Buscar</button>
        {(filtered||draft)&&<button className="button tenant-subtle" type="button" onClick={clear}>Limpar filtros</button>}
      </form>
      <Result state={list}>{data=><>
        {data.items.length?<RecordsTable kind={kind} rows={data.items} selected={item} open={id=>open(kind,id)}/>:
          filtered&&!showOpenEmpty?<TenantEmpty icon="search" title="Nenhum resultado encontrado"
            description="Ajuste os termos da busca ou limpe os filtros para consultar os registros."
            action={<button className="button outline" onClick={clear}>Limpar busca e filtros</button>}/>:
          <TenantEmpty icon={presentation.icon} title={kind==='clients'&&!operate?'Nenhum cliente cadastrado':presentation.empty}
            description={kind==='charges'&&!operate?'As cobranças desta empresa aparecerão aqui.':presentation.help}
            action={creatable&&<NewRecordButton onClick={create}>{createLabel}</NewRecordButton>}/>}
        <TenantPager page={data.page} more={data.hasMore} change={setPage}/>
      </>}</Result>
    </section>
    {creating&&(kind==='clients'||kind==='charges')&&<TenantModal title={createLabel} close={close}>
      <RecordForm root={root} kind={kind} changed={changed}/>
    </TenantModal>}
    {editing&&<TenantModal key={item} title="Editar cliente" close={close}>
      <Result state={detail}>{row=><RecordForm root={root} kind="clients" changed={changed} row={row}/>}</Result>
    </TenantModal>}
    {item&&!editing&&item!=='novo'&&<TenantModal key={item} title={presentation.column+' · detalhes'} close={close} wide>
      <Result state={detail}>{row=><RecordDetails root={root} kind={kind} row={row} operate={operate} open={open}
        changed={changed} simulator={simulator}/>}</Result>
    </TenantModal>}
  </>
}

function initials(value:string){return value.trim().split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase()}

function RecordsTable({kind,rows,selected,open}:{kind:RecordKind;rows:RecordRow[];selected:string;open:(id:string)=>void}){
  const columns={
    clients:['Cliente','E-mail','Cadastro'],
    charges:['Cobrança','Situação','Valor'],
    reviews:['Divergência','Resolução','Valores'],
    events:['Evento','Processamento','Recebido em'],
  }[kind]
  return <table className="tenant-records" data-kind={kind} aria-label={recordNames[kind]}>
    <thead><tr>{columns.map((label,index)=><th scope="col" key={label} className={index===2?'tenant-value':undefined}>{label}</th>)}</tr></thead>
    <tbody>{rows.map(row=>{
      const state=kind==='reviews'?(row.resolution?'resolved':'open'):row.status??row.outcome
      const label=row.name??row.description??(kind==='events'?(row.external_id??row.id):title(row.reason))
      return <tr key={row.id} data-current={selected===row.id}>
        <th scope="row">
          <div className="tenant-record-name">
            {kind==='clients'&&<span className="tenant-avatar" aria-hidden="true">{initials(label)}</span>}
            <div><button className="operation-link" onClick={()=>open(row.id)}>{label}</button>
              {kind==='charges'&&<small>{row.client_name??'Sem cliente'}</small>}
              {kind==='reviews'&&row.charge_id&&<small>Cobrança {row.charge_id}</small>}
              {kind==='events'&&row.amount!=null&&<small>{money(row.amount)}</small>}
              {kind==='clients'&&row.email&&<small className="tenant-mobile-email">{row.email}</small>}
            </div>
          </div>
        </th>
        <td>{kind==='clients'?row.email??'—':state?<><Status value={state}/>{row.resolution&&<small>{title(row.resolution)}</small>}</>: '—'}</td>
        <td className="tenant-value">{kind==='clients'||kind==='events'?date(row.created_at):kind==='reviews'?
          <><small>Esperado {money(row.expected)}</small><small>Recebido {money(row.received)}</small></>:money(row.amount)}</td>
      </tr>
    })}</tbody>
  </table>
}
function RecordForm({root,kind,changed,row}:{root:string;kind:'clients'|'charges';changed:()=>void;row?:RecordRow}){
  const {request:api}=useContext(TenantTransport)
  const action=useMutation()
  const [clientSearch,setClientSearch]=useState('')
  const editField=useRef<HTMLInputElement>(null)
  useEffect(()=>{if(row)editField.current?.focus()},[row?.id])
  const clients=useRemote<Rows>(kind==='charges'?root+'/clients?'+new URLSearchParams({q:clientSearch}):'')
  return <form className="tenant-form tenant-modal-form" aria-busy={action.busy} onSubmit={event=>{
      const data=formData(event),form=event.currentTarget
      const body=kind==='clients'?{name:data.get('name'),email:data.get('email')}:
        {description:data.get('description'),amount:Number(data.get('amount')),clientId:data.get('clientId')}
      void action.run(async()=>{await api(root+'/'+kind+(row?'/'+encodeURIComponent(row.id):''),body);if(!row)form.reset();changed()})
    }}>
      {kind==='clients'?<><label>Nome do cliente<input ref={editField} data-initial-focus name="name" defaultValue={row?.name} required maxLength={120}/></label><label>E-mail<input type="email" name="email" defaultValue={row?.email}/></label></>:
        <><label>Descrição<input data-initial-focus name="description" required maxLength={120}/></label>
          <label>Valor em centavos<input name="amount" type="number" min="1" max="1000000000" required aria-describedby="tenant-charge-amount-help"/><small id="tenant-charge-amount-help">Exemplo: 35000 equivale a R$ 350,00.</small></label>
          <label>Buscar cliente<input value={clientSearch} maxLength={120} onChange={event=>setClientSearch(event.target.value)}/></label>
          <label>Cliente<select aria-label="Cliente" name="clientId"><option value="">Sem cliente</option>
            {clients.data?.items.map(client=><option key={client.id} value={client.id}>{client.name}</option>)}
            </select></label></>}
      <button className="button primary" disabled={action.busy}>{action.busy?'Salvando…':'Salvar'}</button>
      <Feedback value={action.feedback}/>
    </form>
}
function Status({value}:{value:string}){
  const tone=['paid','settled','resolved','active','accepted'].includes(value)?'success':
    value==='conflict'?'error':['divergent','extra','unmatched','open','pending'].includes(value)?'warning':'neutral'
  return <span className="tenant-status" data-tone={tone}>
    <Icon name={tone==='success'?'circleCheck':tone==='warning'||tone==='error'?'alert':'clock'} size={14}/>{title(value)}
  </span>
}

function RecordDetails({root,kind,row,operate,open,changed,simulator}:{root:string;kind:RecordKind;row:RecordRow;operate:boolean;
  open:(kind:string,id:string)=>void;changed:()=>void;simulator:boolean}){
  const {request:api,demo}=useContext(TenantTransport)
  const action=useMutation()
  return <section className="tenant-detail">
    <div className="tenant-inline"><h2>{row.name??row.description??title(row.outcome??row.reason)}</h2></div>
    <dl className="tenant-facts"><div><dt>Identificador</dt><dd>{row.id}</dd></div>
      <div><dt>Registrado em</dt><dd>{date(row.created_at)}</dd></div>
      {kind==='clients'&&<div><dt>E-mail</dt><dd>{row.email??'Não informado'}</dd></div>}
      {row.status&&<div><dt>Situação</dt><dd><Status value={row.status}/></dd></div>}
      {row.amount!==undefined&&<div><dt>Valor</dt><dd>{money(row.amount)}</dd></div>}
      {row.external_id&&<div><dt>Evento externo</dt><dd>{row.external_id}</dd></div>}
      {row.external_payment_id&&<div><dt>Pagamento externo</dt><dd>{row.external_payment_id}</dd></div>}
      {row.received!==undefined&&<><div><dt>Valor esperado</dt><dd>{money(row.expected)}</dd></div>
        <div><dt>Valor recebido</dt><dd>{money(row.received)}</dd></div></>}
      {row.resolution&&<><div><dt>Decisão</dt><dd>{title(row.resolution)}</dd></div>
        <div><dt>Justificativa</dt><dd>{row.justification}</dd></div><div><dt>Autor e horário</dt><dd>{row.resolved_by} · {date(row.resolved_at)}</dd></div></>}
    </dl>
    {kind==='clients'&&operate&&<button className="button outline" onClick={()=>open('clients','editar:'+row.id)}>Editar cliente</button>}
    {row.charge_id&&<button className="button outline" onClick={()=>open('charges',row.charge_id!)}>Abrir cobrança</button>}{' '}
    {row.event_id&&<button className="button outline" onClick={()=>open('events',row.event_id!)}>Abrir evento</button>}{' '}
    {row.review_id&&<button className="button outline" onClick={()=>open('reviews',row.review_id!)}>Abrir revisão</button>}{' '}
    {kind==='charges'&&operate&&simulator&&<button className="button outline" onClick={()=>open('simulator',row.id)}>Simular nesta cobrança</button>}
    {row.deliveries&&<div><h3>Tentativas de entrega</h3><ul>{row.deliveries.map((item,index)=><li key={index}>{title(item.outcome)} · {date(item.created_at)}</li>)}</ul></div>}
    {row.payments&&row.payments.length>0&&<div><h3>Pagamentos simulados</h3><ul>{row.payments.map(item=><li key={item.id}>{money(item.amount)} · {date(item.created_at)}</li>)}</ul></div>}
    {row.events?.map(item=><button key={item.id} className="operation-link" onClick={()=>open('events',item.id)}>Evento · {title(item.outcome)}{' '}</button>)}
    {row.reviews?.map(item=><button key={item.id} className="operation-link" onClick={()=>open('reviews',item.id)}>Revisão · {title(item.reason)}{' '}</button>)}
    {kind==='reviews'&&operate&&!demo&&!row.resolution&&<form className="tenant-inline" onSubmit={event=>{
      const data=formData(event)
      void action.run(async()=>{await api(root+'/reviews/'+row.id+'/resolve',{action:data.get('action'),justification:data.get('justification')});changed()})
    }}>
      <label>Decisão<select aria-label="Decisão" name="action"><option value="close">Encerrar com justificativa</option>
        {row.reason==='divergent'&&<option value="settle">Aceitar divergência e dar baixa</option>}
        <option value="refund_recorded">Registrar devolução externa</option></select></label>
      <label>Justificativa<input name="justification" minLength={5} maxLength={500} required/></label>
      <button className="button primary" disabled={action.busy}>Registrar decisão</button>
    </form>}<Feedback value={action.feedback}/>
  </section>
}

function Simulation({root,initial,open}:{root:string;initial:string;open:(kind:string,id:string)=>void}){
  const {request:api,demo}=useContext(TenantTransport)
  const [scenario,setScenario]=useState('correct'),[charge,setCharge]=useState(initial),[search,setSearch]=useState('')
  const charges=useRemote<Rows>(root+'/charges?'+new URLSearchParams({q:search}))
  const chargeInResults=charges.data?.items.some(item=>item.id===charge)
  const selectedCharge=useRemote<RecordRow>(charge&&!chargeInResults?root+'/charges/'+encodeURIComponent(charge):'')
  const canSubmit=Boolean(charge&&(chargeInResults||selectedCharge.data))
  const [result,setResult]=useState<{charge:string;deliveries:{id:string;outcome:string}[]}>()
  const request=useRef<{scope:string;key:string}|undefined>(undefined)
  const action=useMutation()
  return <><Heading name="Simulador" description={demo?'Ambiente de demonstração. Os cenários usam dados fictícios locais.':'Ambiente de desenvolvimento. Envie cenários de teste ao webhook desta empresa.'}/>
    <div className="simulation-lab">
      <form className="panel tenant-form" onSubmit={event=>{
        event.preventDefault()
        if(!canSubmit)return
        const scope=charge+':'+scenario
        if(request.current?.scope!==scope)request.current={scope,key:crypto.randomUUID()}
        const requestKey=request.current.key
        void action.run(async()=>{
          setResult(undefined)
          const response=await api<{deliveries:{id:string;outcome:string}[]}>(root+'/simulate',{chargeId:charge,scenario,requestKey})
          setResult({charge,deliveries:response.deliveries});request.current=undefined
        })
      }}><h2>1. Escolha a cobrança</h2><label>Buscar cobrança<input value={search} maxLength={120} onChange={event=>setSearch(event.target.value)}/></label>
        <label>Cobrança<select aria-label="Cobrança" value={charge} onChange={event=>setCharge(event.target.value)} required>
          <option value="">Selecione</option>
          {selectedCharge.data&&<option value={charge}>{selectedCharge.data.description} · {money(selectedCharge.data.amount)}</option>}
          {charges.data?.items.map(item=><option key={item.id} value={item.id}>{item.description} · {money(item.amount)}</option>)}
        </select></label><Result state={charges}>{data=>data.items.length?null:<p>Nenhuma cobrança encontrada.</p>}</Result>
        <h2>2. Defina o cenário</h2><label>Cenário<select value={scenario} onChange={event=>setScenario(event.target.value)}>
          <option value="correct">Pagamento correto</option><option value="different">Valor divergente</option>
          <option value="duplicate">Notificação repetida</option>{!demo&&<>
          <option value="extra">Pagamento extra</option><option value="simultaneous">Entregas simultâneas</option></>}
        </select></label>
        {!canSubmit&&<p id="tenant-simulation-help">
          {selectedCharge.loading?'Carregando cobrança selecionada…':'Selecione uma cobrança para executar a simulação.'}
        </p>}
        <Result state={selectedCharge}>{()=>null}</Result>
        <button className="button primary" aria-describedby={!canSubmit?'tenant-simulation-help':undefined} disabled={!canSubmit||action.busy}>{action.busy?'Enviando…':'Executar simulação'}</button>
      </form>
      <section className="panel tenant-box"><h2>{demo?'3. Resultado da simulação':'3. Resultado do webhook'}</h2><Feedback value={action.feedback}/>
        {result?<ul className="tenant-items">{result.deliveries.map((delivery,index)=><li key={index}>
          <button className="operation-link" onClick={()=>open('events',delivery.id)}>{title(delivery.outcome)} · Ver evento</button>
        </li>)}</ul>:action.busy?<p role="status">Processando a notificação de teste…</p>:<p>Execute um cenário para consultar o processamento.</p>}
        {result&&<button className="button outline" onClick={()=>open('charges',result.charge)}>Abrir cobrança</button>}
      </section>
    </div>
  </>
}
function NameSettings({heading,description,label,initial,readOnly=false,accountEmail,save,button}:{
  heading:string;description:string;label:string;initial:string;readOnly?:boolean;accountEmail?:string;
  save:(name:string)=>Promise<void>;button:string
}){
  const [name,setName]=useState(initial)
  const [saved,setSaved]=useState(initial)
  const dirty=name.trim()!==saved
  const action=useMutation()
  return <form className="panel tenant-form tenant-settings-form" onSubmit={event=>{
    event.preventDefault()
    if(!dirty||readOnly)return
    void action.run(async()=>{await save(name.trim());setSaved(name.trim());setName(name.trim())})
  }}>
    <div><h2>{heading}</h2><p>{description}</p></div>
    {accountEmail&&<div className="tenant-readonly"><strong>E-mail da conta</strong><span>{accountEmail}</span></div>}
    <label>{label}<input name="name" value={name} onChange={event=>setName(event.target.value)}
      readOnly={readOnly} minLength={2} maxLength={120} required/></label>
    {!readOnly&&<div className="tenant-form-actions">
      <button className="button primary" disabled={!dirty||action.busy}>{action.busy?'Salvando…':button}</button>
      {dirty&&<span role="status">Alterações não salvas</span>}
    </div>}
    <Feedback value={action.feedback}/>
  </form>
}

function Personal({user,update}:{user:User;update:()=>void}){
  const {request:api}=useContext(TenantTransport)
  return <><Heading name="Perfil" description="Gerencie os dados usados para identificar sua conta."/>
    <NameSettings key={user.id} heading="Dados pessoais" description="Seu nome aparece no menu da conta e na lista da equipe."
      label="Nome" initial={user.name} accountEmail={user.email} button="Salvar perfil"
      save={async name=>{await api('identity/profile',{name});update()}}/>
  </>
}
function Security(){
  const {request:api}=useContext(TenantTransport)
  const action=useMutation(),revoke=useMutation()
  const [dirty,setDirty]=useState(false)
  return <><Heading name="Segurança" description="Altere sua senha ou encerre as sessões abertas em outros dispositivos."/>
    <form className="panel tenant-form tenant-settings-form" onChange={event=>{const data=new FormData(event.currentTarget);setDirty(Boolean(data.get('current')||data.get('password')))}} onSubmit={event=>{
      const data=formData(event)
      void action.run(async()=>{
        await api('identity/password/change',{currentPassword:data.get('current'),password:data.get('password')})
        window.location.replace('/entrar?sessao=expirada')
      })
    }}><h2>Alterar senha</h2>
      <label>Senha atual<input name="current" type="password" autoComplete="current-password" required/></label>
      <label>Nova senha<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={512} required/></label>
      <div className="tenant-form-actions"><button className="button primary" disabled={!dirty||action.busy}>{action.busy?'Salvando…':'Alterar senha'}</button>{dirty&&<span role="status">Alterações não salvas</span>}</div><Feedback value={action.feedback}/>
    </form>
    <section className="panel tenant-box tenant-access-card"><h2>Demais sessões</h2><p>Encerra o acesso em outros dispositivos e mantém esta sessão ativa.</p>
      <button className="button outline" disabled={revoke.busy} onClick={()=>revoke.run(async()=>{await api('identity/sessions/revoke-others',{})})}>Encerrar demais sessões</button>
      <Feedback value={revoke.feedback}/>
    </section>
  </>
}
function CompanyPage({item,root,manage,update}:{item:Company;root:string;manage:boolean;update:()=>void}){
  const {request:api}=useContext(TenantTransport)
  return <><Heading name="Empresa" description="Consulte os dados e seu nível de acesso à empresa ativa."/>
    <div className="tenant-settings-layout">
      <NameSettings key={item.id} heading="Dados da empresa"
        description={manage?'O nome aparece no seletor e identifica o ambiente para todos os membros.':'O nome é administrado pelos responsáveis pela empresa.'}
        label="Nome da empresa" initial={item.name} readOnly={!manage} button="Salvar empresa"
        save={async name=>{await api(root,{name});update()}}/>
      <section className="panel tenant-box tenant-access-card"><h2>Seu acesso</h2><p><strong>{roleNames[item.role]}</strong></p>
        <p>{roleHelp[item.role]}</p></section>
    </div>
  </>
}
const roleHelp:Record<Role,string>={
  owner:'Controla a empresa e pode gerenciar todos os papéis, inclusive proprietários.',
  admin:'Administra a empresa e gerencia pessoas com perfil Financeiro ou Consulta.',
  finance:'Opera clientes, cobranças e revisões.',
  viewer:'Consulta os dados operacionais da empresa.',
}

function RoleField({roles,initial}:{roles:Role[];initial:Role}){
  const [value,setValue]=useState(initial)
  return <label>Papel<select name="role" value={value} onChange={event=>setValue(event.target.value as Role)}>
    {roles.map(role=><option key={role} value={role}>{roleNames[role]}</option>)}
  </select><small>{roleHelp[value]}</small></label>
}

function Team({root,role}:{root:string;role:Role}){
  const {request:api}=useContext(TenantTransport)
  const [revision,setRevision]=useState(0),[page,setPage]=useState(1),[search,setSearch]=useState(''),[draft,setDraft]=useState('')
  const [tab,setTab]=useState<'members'|'invites'>('members')
  const [modal,setModal]=useState<{type:'invite'|'edit'|'revoke';item?:RoleRecord}>()
  const state=useRemote<{members:RoleRecord[];invites:RoleRecord[];hasMore:boolean}>(
    root+'/team?'+new URLSearchParams({page:String(page),q:search}),revision,true)
  const action=useMutation(),editing=useMutation()
  const assignable=(Object.keys(roleNames) as Role[]).filter(item=>role==='owner'||item==='finance'||item==='viewer')
  const canEdit=(target:RoleRecord)=>assignable.includes(target.role)
  function mutate(path:string,body:object,fromModal=false){
    void (fromModal?editing:action).run(async()=>{
      await api(root+path,body)
      setRevision(value=>value+1)
      if(fromModal){setModal(undefined);action.announce()}
    })
  }
  const clear=()=>{setDraft('');setSearch('');setPage(1)}
  const changeTab=(value:typeof tab)=>{setTab(value);setPage(1)}
  const target=modal?.item
  return <>
    <Heading name="Equipe" description="Gerencie quem pode acessar esta empresa e o que cada pessoa pode fazer."
      action={<NewRecordButton onClick={()=>{editing.clear();setModal({type:'invite'})}}>Convidar pessoa</NewRecordButton>}/>
    <Feedback value={action.feedback}/>
    <section className="panel tenant-box tenant-register">
      <div className="tenant-tabs" role="tablist" aria-label="Equipe" onKeyDown={event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
        event.preventDefault()
        const next=event.key==='Home'?'members':event.key==='End'?'invites':tab==='members'?'invites':'members'
        changeTab(next)
        document.getElementById('team-tab-'+next)?.focus()
      }}>
        {(['members','invites'] as const).map(value=><button key={value} id={'team-tab-'+value} role="tab" aria-selected={tab===value}
          aria-controls="team-panel" tabIndex={tab===value?0:-1} onClick={()=>changeTab(value)}>
          {value==='members'?'Membros':'Convites'}
        </button>)}
      </div>
      <div id="team-panel" role="tabpanel" aria-labelledby={'team-tab-'+tab}>
        <form className="tenant-inline tenant-filters" onSubmit={event=>{event.preventDefault();setSearch(draft.trim());setPage(1)}}>
          <label>Buscar {tab==='members'?'membros':'convites'}<span className="tenant-search"><Icon name="search" size={17}/>
            <input type="search" maxLength={120} value={draft} placeholder={tab==='members'?'Nome ou e-mail':'E-mail'}
              onChange={event=>setDraft(event.target.value)}/></span></label>
          <button className="button outline">Buscar</button>
          {(search||draft)&&<button type="button" className="button tenant-subtle" onClick={clear}>Limpar busca</button>}
        </form>
        <Result state={state}>{data=><>
          {data[tab].length?<ul className="tenant-team-list">{data[tab].map(item=><li key={item.id}>
            <div className="tenant-team-person">
              <span className="tenant-avatar" aria-hidden="true">{initials(item.name??item.email)}</span>
              <div><strong>{item.name??item.email}</strong>
                {item.name&&<span>{item.email}</span>}
                {tab==='invites'&&item.expires_at&&<span>Expira em {date(item.expires_at)}</span>}
              </div>
            </div>
            <span>{roleNames[item.role]}</span>
            <Status value={tab==='members'?(item.active?'active':'inactive'):item.status??'pending'}/>
            {tab==='members'&&canEdit(item)&&<button className="button outline" onClick={()=>{editing.clear();setModal({type:'edit',item})}}>Editar vínculo</button>}
            {tab==='invites'&&item.status==='pending'&&canEdit(item)&&<div className="tenant-inline">
              <button className="button outline" disabled={action.busy} onClick={()=>mutate('/invites/'+item.id+'/resend',{})}>Reenviar</button>
              <button className="button outline" disabled={action.busy} onClick={()=>{editing.clear();setModal({type:'revoke',item})}}>Revogar</button>
            </div>}
          </li>)}</ul>:<TenantEmpty icon="people"
            title={search?'Nenhum resultado encontrado':tab==='members'?'Nenhum membro nesta página':'Nenhum convite nesta página'}
            description={search?'Tente outro termo ou limpe a busca.':tab==='invites'?'Os convites enviados aparecerão aqui.':'Os vínculos da empresa aparecem nesta lista.'}/>}
          <TenantPager page={page} more={data.hasMore&&data[tab].length===20} change={setPage}/>
        </>}</Result>
      </div>
    </section>
    {modal&&<TenantModal title={modal.type==='invite'?'Convidar pessoa':modal.type==='edit'?'Editar vínculo':'Revogar convite'}
      close={()=>{if(!editing.busy)setModal(undefined)}}>
      <form className="tenant-form tenant-modal-form" aria-busy={editing.busy} onSubmit={event=>{
        const data=formData(event)
        if(modal.type==='invite')mutate('/invites',{email:data.get('email'),role:data.get('role')},true)
        if(modal.type==='edit'&&target)mutate('/members/'+target.id,{role:data.get('role'),active:data.get('active')==='true'},true)
        if(modal.type==='revoke'&&target)mutate('/invites/'+target.id+'/revoke',{},true)
      }}>
        {modal.type==='invite'&&<><label>E-mail do convidado<input type="email" name="email" required data-initial-focus/></label>
          <RoleField roles={assignable} initial="viewer"/></>}
        {modal.type==='edit'&&target&&<><p>{target.name} · {target.email}</p><RoleField roles={assignable} initial={target.role}/>
          <label>Vínculo<select defaultValue={String(target.active)} name="active">
            <option value="true">Ativo</option><option value="false">Inativo</option>
          </select></label><small>O último proprietário ativo precisa manter o acesso à empresa.</small></>}
        {modal.type==='revoke'&&target&&<p>O link enviado para {target.email} perderá a validade.</p>}
        <Feedback value={editing.feedback}/>
        <button className="button primary" disabled={editing.busy}>
          {editing.busy?'Salvando…':modal.type==='invite'?'Convidar':modal.type==='edit'?'Salvar vínculo':'Confirmar revogação'}
        </button>
      </form>
    </TenantModal>}
  </>
}

function CompanyDirectory({revision,choose,create}:{revision:number;choose:(id:string)=>void;create:(name:string)=>Promise<void>}){
  const [q,setQuery]=useState(''),[page,setPage]=useState(1)
  const action=useMutation()
  const list=useRemote<{items:Company[];page:number;hasMore:boolean}>(
    'tenant/companies?'+new URLSearchParams({q,page:String(page)}),revision)
  const empty=list.data?.items.length===0&&!q&&page===1
  return <>
    <Heading name="Escolha sua empresa" description="Acesse um dos seus ambientes para acompanhar cobranças e pagamentos Pix."/>
    <div className="tenant-company-layout" data-first-company={empty}>
      <section className="panel tenant-box tenant-directory" aria-labelledby="company-directory-title">
        <h2 id="company-directory-title">{empty?'Seu primeiro ambiente':'Suas empresas'}</h2>
        {!empty&&<form className="tenant-inline" onSubmit={event=>{setQuery(String(formData(event).get('q')??'').trim());setPage(1)}}>
          <label>Buscar empresa<input type="search" name="q" maxLength={120}/></label>
          <button className="button outline">Buscar</button>
        </form>}
        <Result state={list}>{data=><>
          {data.items.length?<ul className="tenant-company-list">{data.items.map(item=><li key={item.id}>
            <span className="tenant-company-icon"><Icon name="store" size={20}/></span>
            <div><strong>{item.name}</strong><p>{roleNames[item.role]}</p><small>ID da empresa: {item.id}</small></div>
            <button className="button outline" aria-label={'Acessar '+item.name} onClick={()=>choose(item.id)}>
              Acessar <Icon name="right" size={15}/>
            </button>
          </li>)}</ul>:empty?<div className="tenant-empty">
            <span className="tenant-company-icon"><Icon name="store" size={23}/></span>
            <h3>Você ainda não tem empresas</h3><p>Crie sua primeira empresa para organizar clientes, cobranças e recebimentos.</p>
          </div>:<p className="tenant-empty">Nenhuma empresa corresponde à sua busca.</p>}
          {(page>1||data.hasMore)&&<div className="tenant-inline pager"><button className="button outline" disabled={page===1} onClick={()=>setPage(page-1)}>Anterior</button>
            <span>Página {data.page}</span><button className="button outline" disabled={!data.hasMore} onClick={()=>setPage(page+1)}>Próxima</button></div>}
        </>}</Result>
      </section>
      <form className="panel tenant-form tenant-new-company" onSubmit={event=>{
        const name=String(formData(event).get('name')??'').trim()
        void action.run(()=>create(name))
      }}>
        <h2>{empty?'Crie sua primeira empresa':'Nova empresa'}</h2>
        <label>Nome da empresa<input name="name" maxLength={120} required/></label>
        <button className={'button '+(empty?'primary':'outline')} disabled={action.busy}>{action.busy?'Criando…':'Criar empresa'}</button>
        <Feedback value={action.feedback}/>
      </form>
    </div>
  </>
}
