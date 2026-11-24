import { dayKey } from './Finance'
import { demoRepository, type Scenario, type ProcessingResult } from './model'
import { ApiIssue } from './tenant-api'

export const demoCompany = 'demonstracao'
const company={id:demoCompany,name:'Loja demonstração',role:'finance',simulator:true}
const resultLabels:Record<ProcessingResult,string>={conciliado:'settled',divergente:'divergent',extra:'extra',duplicado:'duplicate'}
const clients=new Map<string,{id:string;name:string;email:string;created_at:string}>()
const details=new Map<number,{description:string;clientId:string}>()
let loaded=false

export async function demoApi<T>(path:string,body?:object):Promise<T>{
  const missing=()=>new ApiIssue(404,'Registro não encontrado.')
  const reply=(value:unknown)=>value as T
  if(path==='identity/session')return reply({user:{id:'demonstracao',name:'Demonstração',email:''}})
  if(path==='tenant/companies')return reply([company])
  const route=path.split('?')[0].split('/')
  if(route[0]!=='tenant'||route[1]!=='companies'||route[2]!==demoCompany)throw missing()
  if(route.length===3&&!body)return reply(company)
  const [,,,kind,id]=route
  const query=new URLSearchParams(path.split('?')[1])
  const charges=await demoRepository.list()
  if(!loaded){
    for(const charge of charges){
      const clientId='cliente-'+charge.id
      clients.set(clientId,{id:clientId,name:charge.customer,email:'',created_at:charge.createdAt})
      details.set(charge.id,{description:'Pedido #'+charge.id,clientId})
    }
    loaded=true
  }

  const chargeRows=charges.map(charge=>{
    const meta=details.get(charge.id)
    return {id:String(charge.id),description:meta?.description??charge.customer,
      client_name:clients.get(meta?.clientId??'')?.name,created_at:charge.createdAt,
      amount:charge.expected,status:charge.status==='conciliada'?'paid':'pending',
      payments:charge.payments.map(payment=>({...payment,created_at:payment.time})),
      events:charge.notifications.map(event=>({id:event.id,outcome:resultLabels[event.result]})),
      reviews:charge.reviews.map(review=>({id:review.id,reason:review.reason==='extra'?'extra':'divergent'}))}
  })
  const events=charges.flatMap(charge=>charge.notifications.map(event=>{
    const review=charge.reviews.find(item=>item.notificationId===(event.duplicateOf??event.id))
    return {id:event.id,external_id:event.id,external_payment_id:event.paymentId,charge_id:String(charge.id),
      outcome:resultLabels[event.result],amount:event.amount,created_at:event.time,review_id:review?.id,
      deliveries:charge.notifications.filter(item=>(item.duplicateOf??item.id)===(event.duplicateOf??event.id))
        .map(item=>({outcome:resultLabels[item.result],created_at:item.time}))}
  }))
  const reviews=charges.flatMap(charge=>charge.reviews.map(review=>({id:review.id,charge_id:String(charge.id),
    reason:review.reason==='extra'?'extra':'divergent',event_id:review.notificationId,expected:review.expected,received:review.received,
    charge_description:details.get(charge.id)?.description,client_name:clients.get(details.get(charge.id)?.clientId??'')?.name,
    created_at:review.time,resolution:null})))
  if(kind==='overview'){
    const days=query.get('days')==='30'?30:7
    const start=new Date(dayKey.format(new Date())+'T12:00:00Z')
    start.setUTCDate(start.getUTCDate()-days+1)
    const earliest=start.toISOString().slice(0,10)
    const payments=charges.flatMap(charge=>charge.payments)
    const totals=new Map<string,number>()
    for(const payment of payments){
      const day=dayKey.format(new Date(payment.time))
      if(day>=earliest)totals.set(day,(totals.get(day)??0)+payment.amount)
    }
    const pending=chargeRows.filter(row=>row.status==='pending')
    const activity=[
      ...events.map(event=>({...event,kind:'events',description:details.get(Number(event.charge_id))?.description})),
      ...chargeRows.map(row=>({...row,kind:'charges',outcome:'created'})),
    ].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,5)
    return reply({paid:String(payments.filter(row=>row.settled).reduce((sum,row)=>sum+row.amount,0)),
      pending:String(pending.reduce((sum,row)=>sum+row.amount,0)),paidCount:chargeRows.length-pending.length,
      pendingCount:pending.length,reviews:reviews.length,activity,
      series:[...totals.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([day,amount])=>({day,amount:String(amount)}))})
  }
  const input=body as Record<string,unknown>|undefined
  if(kind==='simulate'&&input){
    const scenario=input.scenario
    if(scenario!=='correct'&&scenario!=='duplicate'&&scenario!=='different')throw new ApiIssue(400,'Cenário indisponível na demonstração.')
    try{
      const {notification}=await demoRepository.demonstration!.simulate(Number(input.chargeId),scenario as Scenario)
      return reply({deliveries:[{id:notification.id,outcome:resultLabels[notification.result]}]})
    }catch(error){throw new ApiIssue(400,error instanceof Error?error.message:'Falha na simulação.')}
  }
  if(kind==='clients'&&input){
    const name=String(input.name??'').trim()
    if(name.length<2)throw new ApiIssue(400,'Informe o nome do cliente.')
    if(id&&!clients.has(id))throw missing()
    const client=id??crypto.randomUUID()
    clients.set(client,{id:client,name,email:String(input.email??''),created_at:clients.get(client)?.created_at??new Date().toISOString()})
    return reply(id?undefined:{id:client})
  }
  if(kind==='charges'&&input&&!id){
    const description=String(input.description??'').trim()
    const amount=Number(input.amount)
    if(!description||!Number.isSafeInteger(amount)||amount<1)throw new ApiIssue(400,'Informe a descrição e um valor válido.')
    const record=await demoRepository.create(description,amount)
    details.set(record.id,{description,clientId:String(input.clientId??'')})
    return reply({id:String(record.id)})
  }
  const groups={clients:[...clients.values()],charges:chargeRows,events,reviews}
  if(body||!Object.hasOwn(groups,kind))throw missing()
  const rows=groups[kind as keyof typeof groups]
  if(id){
    const row=rows.find(item=>item.id===decodeURIComponent(id))
    if(!row)throw missing()
    return reply(row)
  }
  const term=(query.get('q')??'').toLocaleLowerCase('pt-BR')
  const filter=query.get('filter')??''
  const page=Number(query.get('page')??1)
  const found=rows.filter(row=>{
    const fields=kind==='clients'?['name','email']:kind==='charges'?['id','description','client_name']:
      kind==='events'?['id','external_id','external_payment_id','charge_id']:['id','charge_id']
    const data=row as Record<string,unknown>
    return fields.some(field=>String(data[field]??'').toLocaleLowerCase('pt-BR').includes(term))
      &&(!filter||(kind==='reviews'?filter==='open':(data.status??data.outcome)===filter))
  }).sort((a,b)=>b.created_at.localeCompare(a.created_at))
  return reply({items:found.slice((page-1)*20,page*20),page,hasMore:found.length>page*20})
}
