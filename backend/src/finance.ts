import { createHash,randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { audit,requestId } from './audit'
import { transaction } from './db'
import { bodyObject,normalizeEmail,PublicError } from './identity'
import { bad,cents,conflict,missing,Tenants,textField,uuid } from './tenants'

const definitions={
  clients:{table:'tenant_clients',fields:'r.*',joins:'',match:'r.name ILIKE $2 OR r.email ILIKE $2',filter:'true'},
  charges:{table:'tenant_charges',fields:'r.*,c.name AS client_name',joins:'LEFT JOIN tenant_clients c ON c.company_id=r.company_id AND c.id=r.client_id',
    match:'r.description ILIKE $2 OR c.name ILIKE $2 OR r.id::text ILIKE $2',filter:"($3='' OR r.status=$3)"},
  events:{table:'tenant_events',fields:'r.*,p.charge_id',joins:'LEFT JOIN tenant_payments p ON p.company_id=r.company_id AND p.id=r.payment_id',
    match:'r.external_id::text ILIKE $2 OR r.external_payment_id::text ILIKE $2 OR r.id::text ILIKE $2 OR r.requested_charge_id::text ILIKE $2',filter:"($3='' OR r.outcome=$3 OR EXISTS (SELECT 1 FROM tenant_deliveries d WHERE d.company_id=r.company_id AND d.event_id=r.id AND d.outcome=$3))"},
  reviews:{table:'tenant_reviews',fields:'r.*,p.charge_id,c.description AS charge_description,client.name AS client_name',
    joins:`JOIN tenant_payments p ON p.company_id=r.company_id AND p.id=r.payment_id
      LEFT JOIN tenant_charges c ON c.company_id=r.company_id AND c.id=p.charge_id
      LEFT JOIN tenant_clients client ON client.company_id=c.company_id AND client.id=c.client_id`,
    match:'r.id::text ILIKE $2 OR p.charge_id::text ILIKE $2',filter:"($3='' OR $3='open' AND r.resolution IS NULL OR $3='resolved' AND r.resolution IS NOT NULL)"},
} as const
export type Resource=keyof typeof definitions
export function resource(value:string):Resource {
  if(!Object.hasOwn(definitions,value)) throw missing()
  return value as Resource
}
function positivePage(value:unknown) {
  if(value===undefined) return 1
  if(typeof value!=='string'||!/^\d{1,5}$/.test(value)||Number(value)<1) throw bad('Página inválida.')
  return Number(value)
}

export class Finance {
  constructor(private pool:Pool,private tenants:Tenants,private simulator?:{url:string;secret:string}){}
  list(company:string,user:string,kind:Resource,query:Record<string,unknown>){
    const q=query.q===undefined||query.q===''?'':textField(query.q,120,1)
    const filter=query.filter===undefined||query.filter===''?'':textField(query.filter,32,1)
    const page=positivePage(query.page)
    const data=definitions[kind]
    return this.tenants.scope(company,user,'read',false,async(db,scope)=>{
      const load=async()=>{
        const {rows}=await db.query(`SELECT ${data.fields} FROM ${data.table} r ${data.joins}
          WHERE r.company_id=$1 AND ($2='%%' OR (${data.match})) AND ${data.filter} AND $3::text IS NOT NULL
          ORDER BY r.created_at DESC,r.id DESC LIMIT 21 OFFSET $4`,
        [company,'%'+q.replace(/[\\%_]/g,'\\$&')+'%',filter,(page-1)*20])
        return {items:rows.slice(0,20),page,hasMore:rows.length>20}
      }
      return kind==='clients'?this.tenants.cached(db,scope,JSON.stringify([kind,q,filter,page]),load):load()
    })
  }
  detail(company:string,user:string,kind:Resource,id:string){
    const data=definitions[kind]
    return this.tenants.scope(company,user,'read',false,async db=>{
      const {rows:[row]}=await db.query(`SELECT ${data.fields} FROM ${data.table} r ${data.joins}
        WHERE r.company_id=$1 AND r.id=$2`,[company,uuid(id)])
      if(!row) throw missing()
      if(kind==='events'){
        const {rows:[review]}=await db.query('SELECT id FROM tenant_reviews WHERE company_id=$1 AND payment_id=$2',[company,row.payment_id])
        row.review_id=review?.id??null
        row.deliveries=(await db.query('SELECT outcome,created_at FROM tenant_deliveries WHERE company_id=$1 AND event_id=$2 ORDER BY id DESC',[company,id])).rows
      }
      if(kind==='charges'){
        row.payments=(await db.query('SELECT id,amount,settled,created_at FROM tenant_payments WHERE company_id=$1 AND charge_id=$2 ORDER BY created_at DESC',[company,id])).rows
        row.events=(await db.query(`SELECT e.id,e.outcome,e.created_at FROM tenant_events e JOIN tenant_payments p
          ON p.company_id=e.company_id AND p.id=e.payment_id WHERE e.company_id=$1 AND p.charge_id=$2 ORDER BY e.created_at DESC`,[company,id])).rows
        row.reviews=(await db.query(`SELECT r.id,r.reason,r.resolution FROM tenant_reviews r JOIN tenant_payments p
          ON p.company_id=r.company_id AND p.id=r.payment_id WHERE r.company_id=$1 AND p.charge_id=$2`,[company,id])).rows
      }
      return row
    })
  }
  overview(company:string,user:string,days:unknown){
    const span=days==='30'?30:7
    if(days!==undefined&&days!=='7'&&days!=='30') throw bad('Período inválido.')
    return this.tenants.scope(company,user,'read',false,(db,scope)=>this.tenants.cached(db,scope,'overview:v3:'+span,async()=>{
      const {rows:[totals]}=await db.query(`SELECT
        (SELECT coalesce(sum(amount),0)::text FROM tenant_payments WHERE company_id=$1 AND settled) AS paid,
        (SELECT coalesce(sum(amount),0)::text FROM tenant_charges WHERE company_id=$1 AND status='pending') AS pending,
        (SELECT count(*)::int FROM tenant_charges WHERE company_id=$1 AND status='paid') AS "paidCount",
        (SELECT count(*)::int FROM tenant_charges WHERE company_id=$1 AND status='pending') AS "pendingCount",
        (SELECT count(*)::int FROM tenant_reviews WHERE company_id=$1 AND resolution IS NULL) AS reviews`,[company])
      const series=(await db.query(`SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,sum(amount)::text amount
        FROM tenant_payments WHERE company_id=$1 AND created_at >=
          (((now() AT TIME ZONE 'America/Sao_Paulo')::date-($2::int-1))::timestamp AT TIME ZONE 'America/Sao_Paulo')
        GROUP BY 1 ORDER BY 1`,[company,span])).rows
      const activity=(await db.query(`SELECT id,outcome,amount,created_at,kind,description FROM (
        SELECT e.id,e.outcome,e.amount,e.created_at,'events' AS kind,c.description
        FROM tenant_events e LEFT JOIN tenant_charges c ON c.company_id=e.company_id AND c.id=e.requested_charge_id
        WHERE e.company_id=$1
        UNION ALL
        SELECT id,'created' AS outcome,amount,created_at,'charges' AS kind,description FROM tenant_charges WHERE company_id=$1
      ) AS timeline ORDER BY created_at DESC,id DESC LIMIT 5`,[company])).rows
      return {...totals,series,activity}
    }))
  }
  create(company:string,user:string,kind:'clients'|'charges',input:unknown){
    const body=bodyObject(input), id=randomUUID()
    return this.tenants.scope(company,user,'operate',true,async db=>{
      if(kind==='clients'){
        const name=textField(body.name),email=body.email?normalizeEmail(body.email):null
        await db.query('INSERT INTO tenant_clients(company_id,id,name,email) VALUES($1,$2,$3,$4)',[company,id,name,email])
      }else{
        const description=textField(body.description),amount=cents(body.amount),client=body.clientId?uuid(body.clientId):null
        if(client && !(await db.query('SELECT 1 FROM tenant_clients WHERE company_id=$1 AND id=$2',[company,client])).rowCount) throw missing()
        await db.query('INSERT INTO tenant_charges(company_id,id,client_id,description,amount) VALUES($1,$2,$3,$4,$5)',[company,id,client,description,amount])
      }
      await audit(db,company,user,kind+'.create',id)
      return {id}
    })
  }
  editClient(company:string,user:string,id:string,input:unknown){
    const body=bodyObject(input), client=uuid(id)
    const name=textField(body.name), email=body.email?normalizeEmail(body.email):null
    return this.tenants.scope(company,user,'operate',true,async db=>{
      const {rowCount}=await db.query('UPDATE tenant_clients SET name=$3,email=$4 WHERE company_id=$1 AND id=$2',[company,client,name,email])
      if(!rowCount)throw missing()
      await audit(db,company,user,'clients.update',client)
    })
  }
  resolve(company:string,user:string,id:string,input:unknown){
    const body=bodyObject(input), justification=textField(body.justification,500,5),action=body.action
    if(action!=='close'&&action!=='settle'&&action!=='refund_recorded') throw bad('Resolução inválida.')
    return this.tenants.scope(company,user,'operate',true,async db=>{
      const {rows:[review]}=await db.query(`SELECT r.*,p.charge_id FROM tenant_reviews r
        JOIN tenant_payments p ON p.company_id=r.company_id AND p.id=r.payment_id
        WHERE r.company_id=$1 AND r.id=$2`,[company,uuid(id)])
      if(!review) throw missing()
      if(review.resolution) throw conflict('A revisão já foi resolvida.')
      if(action==='settle'){
        if(review.reason!=='divergent'||!review.charge_id) throw bad('A baixa manual exige divergência em cobrança pendente.')
        const changed=await db.query("UPDATE tenant_charges SET status='paid' WHERE company_id=$1 AND id=$2 AND status='pending'",[company,review.charge_id])
        if(!changed.rowCount) throw conflict('A cobrança já foi baixada.')
        await db.query('UPDATE tenant_payments SET settled=true WHERE company_id=$1 AND id=$2',[company,review.payment_id])
      }
      await db.query('UPDATE tenant_reviews SET resolution=$3,justification=$4,resolved_by=$5,resolved_at=now() WHERE company_id=$1 AND id=$2',
        [company,id,action,justification,user])
      await audit(db,company,user,'review.'+action,id)
    })
  }
  async simulate(company:string,user:string,input:unknown){
    const simulator=this.simulator
    if(!simulator) throw missing()
    const body=bodyObject(input), chargeId=uuid(body.chargeId), scenario=body.scenario
    if(!['correct','different','extra','duplicate','simultaneous'].includes(String(scenario))) throw bad('Cenário inválido.')
    const requestKey=body.requestKey===undefined?randomUUID():uuid(body.requestKey)
    const payload=await this.tenants.scope(company,user,'operate',true,async db=>{
      const {rows:[charge]}=await db.query('SELECT amount,status FROM tenant_charges WHERE company_id=$1 AND id=$2',[company,chargeId])
      if(!charge) throw missing()
      if(scenario==='extra'&&charge.status!=='paid') throw bad('Selecione uma cobrança já paga para simular um extra.')
      const {rows:[provider]}=await db.query("SELECT id FROM tenant_providers WHERE company_id=$1 AND kind='simulator'",[company])
      await audit(db,company,user,'simulator.request',chargeId,String(scenario))
      if(scenario==='duplicate'){
        const {rows:[previous]}=await db.query(`SELECT external_id,external_payment_id,amount FROM tenant_events
          WHERE company_id=$1 AND provider_id=$2 AND requested_charge_id=$3 AND payment_id IS NOT NULL
          AND outcome<>'conflict' ORDER BY created_at DESC LIMIT 1`,[company,provider.id,chargeId])
        if(!previous) throw bad('Simule um pagamento antes de fazer o reenvio.')
        return {providerId:provider.id,chargeId,eventId:previous.external_id,paymentId:previous.external_payment_id,amount:previous.amount}
      }
      return {providerId:provider.id,chargeId,eventId:requestKey,paymentId:requestKey,
        amount:scenario==='different'?(charge.amount>1?charge.amount-1:2):scenario==='extra'?Math.max(1,Math.round(charge.amount/10)):charge.amount}
    })
    const deliver=async()=>{
      let response:Response
      try {
        response=await fetch(simulator.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+simulator.secret,'X-Correlation-Id':requestId.getStore()??randomUUID()},
          body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(8000)})
      }catch{throw new PublicError(503,'SIMULATOR_UNAVAILABLE','O webhook simulado não respondeu. Consulte Eventos antes de tentar novamente.')}
      if(!response.ok) throw new PublicError(response.status===409?409:502,'WEBHOOK_FAILED','O webhook registrou um conflito ou não concluiu a entrega.')
      return response.json() as Promise<{id:string;outcome:string}>
    }
    const deliveries=await Promise.all(Array.from({length:scenario==='simultaneous'?2:1},deliver))
    return {deliveries}
  }
  webhook(input:unknown){
    const body=bodyObject(input),provider=uuid(body.providerId),external=uuid(body.eventId),
      paymentExternal=uuid(body.paymentId),chargeId=uuid(body.chargeId),amount=cents(body.amount)
    const fingerprint=createHash('sha256').update(JSON.stringify([paymentExternal,chargeId,amount])).digest('hex')
    return transaction(this.pool,async db=>{
      const {rows:[source]}=await db.query("SELECT company_id FROM tenant_providers WHERE id=$1 AND kind='simulator'",[provider])
      if(!source) throw missing()
      const company=String(source.company_id)
      await db.query('SELECT id FROM tenant_companies WHERE id=$1 FOR UPDATE',[company])
      const {rows:[known]}=await db.query('SELECT id,fingerprint FROM tenant_events WHERE company_id=$1 AND provider_id=$2 AND external_id=$3',[company,provider,external])
      async function finish(id:string,outcome:string){
        await db.query('INSERT INTO tenant_deliveries(company_id,event_id,fingerprint,outcome) VALUES($1,$2,$3,$4)',[company,id,fingerprint,outcome])
        await audit(db,company,'simulator:'+provider,'webhook.delivery',id,outcome)
        await db.query('UPDATE tenant_companies SET version=version+1 WHERE id=$1',[company])
        return {id,outcome}
      }
      if(known) return finish(known.id,known.fingerprint===fingerprint?'duplicate':'conflict')
      const id=randomUUID()
      const {rows:[previous]}=await db.query(`SELECT p.id,e.fingerprint FROM tenant_payments p JOIN tenant_events e
        ON e.company_id=p.company_id AND e.payment_id=p.id
        WHERE p.company_id=$1 AND p.provider_id=$2 AND p.external_id=$3 AND e.outcome NOT IN ('duplicate','conflict') ORDER BY e.created_at,e.id LIMIT 1`,[company,provider,paymentExternal])
      async function event(payment:string,outcome:string){
        await db.query(`INSERT INTO tenant_events(company_id,id,provider_id,external_id,external_payment_id,requested_charge_id,amount,fingerprint,payment_id,outcome)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[company,id,provider,external,paymentExternal,chargeId,amount,fingerprint,payment,outcome])
      }
      if(previous){
        const outcome=previous.fingerprint===fingerprint?'duplicate':'conflict'
        await event(previous.id,outcome)
        return finish(id,outcome)
      }
      const {rows:[charge]}=await db.query('SELECT amount,status FROM tenant_charges WHERE company_id=$1 AND id=$2',[company,chargeId])
      const outcome=!charge?'unmatched':charge.status==='paid'?'extra':charge.amount===amount?'settled':'divergent'
      const payment=randomUUID()
      await db.query('INSERT INTO tenant_payments(company_id,id,provider_id,charge_id,external_id,amount,settled) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [company,payment,provider,charge?chargeId:null,paymentExternal,amount,outcome==='settled'])
      await event(payment,outcome)
      if(outcome==='settled') await db.query("UPDATE tenant_charges SET status='paid' WHERE company_id=$1 AND id=$2",[company,chargeId])
      else await db.query('INSERT INTO tenant_reviews(company_id,id,payment_id,event_id,reason,expected,received) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [company,randomUUID(),payment,id,outcome,charge?.amount??null,amount])
      return finish(id,outcome)
    })
  }
}






