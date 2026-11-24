import assert from 'node:assert/strict'
import { randomBytes,randomUUID } from 'node:crypto'
import { after,before,test } from 'node:test'
import { Pool } from 'pg'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Account } from '../src/account'
import { Finance } from '../src/finance'
import { createApp } from '../src/http'
import { Identity } from '../src/identity'
import { migrate } from '../src/migrate'
import { MailOutbox } from '../src/outbox'
import { Sessions } from '../src/sessions'
import { Tenants } from '../src/tenants'
import { ConfirmationTokens } from '../src/tokens'

const database=process.env.TEST_DATABASE_URL
if(!database)throw new Error('TEST_DATABASE_URL obrigatória.')
const schema='test_tenant_'+randomUUID().replaceAll('-','')
const admin=new Pool({connectionString:database})
const pool=new Pool({connectionString:database,options:'-c search_path='+schema})
const keys=new ConfirmationTokens('test',new Map([['test',randomBytes(32)]]))
const identity=new Identity(pool,keys)
const tenant=new Tenants(pool,keys)
const simulator={url:'',secret:randomBytes(32).toString('base64url')}
const finance=new Finance(pool,tenant,simulator)
const origin='http://localhost:5173'
const mail:{to:string;link:URL;purpose:string}[]=[]
const outbox=new MailOutbox(pool,keys,new URL(origin+'/confirmar-email'),async value=>{mail.push(value)})
const password='senha longa de integração'
type Person={id:string;email:string;cookie:string}
let app:NestExpressApplication
let endpoint:string

before(async()=>{
  await admin.query('CREATE SCHEMA '+schema)
  await migrate(pool)
  app=await createApp(identity,false,['loopback'],{origins:[origin],service:await Sessions.create(pool,randomBytes(32)),
    domain:{account:new Account(pool,keys),tenants:tenant,finance,simulatorSecret:simulator.secret}})
  await app.listen(0,'127.0.0.1')
  endpoint=await app.getUrl()+'/api/'
  simulator.url=endpoint+'tenant/webhook/simulator'
})
after(async()=>{
  await app?.close()
  await pool.end()
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE')
  await admin.end()
})

const team=(company:string)=>'tenant/companies/'+company
function call(path:string,cookie='',body?:object,headers:Record<string,string>={}){
  return fetch(endpoint+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,
    ...(body===undefined?{}:{'Content-Type':'application/json','X-ConciliaPix-CSRF':'1'}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})})
}
async function login(email:string,currentPassword=password,source='198.51.100.1'){
  return call('identity/login','',{email,password:currentPassword},{'X-Forwarded-For':source})
}
function cookie(response:Response){
  const header=response.headers.get('set-cookie')
  assert.ok(header)
  return header.split(';')[0]
}
async function person(label:string):Promise<Person>{
  const email=label+'@example.test'
  await identity.register({name:'Pessoa '+label,email,password})
  const {rows:[user]}=await pool.query('UPDATE identity_users SET email_confirmed_at=now() WHERE email=$1 RETURNING id',[email])
  const response=await login(email)
  assert.equal(response.status,204)
  return {id:user.id,email,cookie:cookie(response)}
}
async function company(member:Person,name:string,key=randomUUID()){
  const response=await call('tenant/companies',member.cookie,{name,requestKey:key})
  assert.equal(response.status,201)
  return (await response.json() as {id:string}).id
}
async function sent(email:string,purpose:string){
  while(await outbox.processOne()) { /* emulate a separate worker after commit */ }
  const item=mail.filter(item=>item.to===email&&item.purpose===purpose).at(-1)
  assert.ok(item)
  return {token:new URLSearchParams(item.link.hash.slice(1)).get('token')!,path:item.link.pathname}
}
async function idFor(response:Response){
  assert.equal(response.status,201)
  return (await response.json() as {id:string}).id
}
async function invite(owner:Person,company:string,member:Person,role:string){
  return idFor(await call(team(company)+'/invites',owner.cookie,{email:member.email,role}))
}
async function accept(member:Person,token:string){
  return call('tenant/invites/accept',member.cookie,{token})
}

test('recuperação é genérica, separa finalidade, expira e revoga sessões mesmo concorrendo com login',async()=>{
  const user=await person('recovery')
  const another=cookie(await login(user.email))
  const generic=await call('identity/password/request','',{email:'ausente@example.test'})
  assert.equal(generic.status,202)
  const valid=await call('identity/password/request','',{email:user.email})
  assert.deepEqual(await valid.json(),await generic.json())
  const link=await sent(user.email,'reset_password')
  assert.equal(link.path,'/redefinir-senha')
  assert.equal((await call('identity/confirm','',{token:link.token})).status,400)
  await pool.query("UPDATE identity_email_tokens SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND purpose='reset_password'",[user.id])
  assert.equal((await call('identity/password/reset','',{token:link.token,password:'nova senha longa de teste'})).status,410)
  await pool.query("UPDATE identity_email_tokens SET expires_at=now()+interval '1 day' WHERE user_id=$1 AND purpose='reset_password'",[user.id])
  const results=await Promise.all([
    call('identity/password/reset','',{token:link.token,password:'nova senha longa de teste'}),
    call('identity/password/reset','',{token:link.token,password:'nova senha longa de teste'}),
    login(user.email),
  ])
  assert.deepEqual(results.slice(0,2).map(item=>item.status).sort(),[204,409])
  for(const value of [user.cookie,another,...(results[2].status===204?[cookie(results[2])]:[])]){
    assert.equal((await call('identity/session',value)).status,401)
  }
  assert.equal((await login(user.email)).status,401)
  const fresh=cookie(await login(user.email,'nova senha longa de teste'))
  assert.equal((await call('identity/profile',fresh,{name:'Nome atualizado'})).status,204)
  const third=cookie(await login(user.email,'nova senha longa de teste'))
  assert.equal((await call('identity/sessions/revoke-others',fresh,{})).status,204)
  assert.equal((await call('identity/session',third)).status,401)
  assert.equal((await call('identity/password/change',fresh,{currentPassword:'errada',password:'senha modificada forte'})).status,401)
  assert.equal((await call('identity/password/change',fresh,{currentPassword:'nova senha longa de teste',password:'senha modificada forte'})).status,204)
  assert.equal((await call('identity/session',fresh)).status,401)
  assert.equal((await login(user.email,'senha modificada forte')).status,204)
})

test('empresas, convites, proprietário, papéis e isolamento inclusive com sessões abertas',async()=>{
  const [owner,manager,operator,reader,outsider]=await Promise.all(['owner','admin','finance','viewer','outsider'].map(person))
  const key=randomUUID()
  const [one,repeat]=await Promise.all([company(owner,'Empresa A',key),company(owner,'Empresa A',key)])
  assert.equal(one,repeat)
  assert.equal((await pool.query("SELECT count(*)::int n FROM tenant_members WHERE company_id=$1 AND role='owner'",[one])).rows[0].n,1)
  const two=await company(owner,'Empresa B')
  const managerInvite=await invite(owner,one,manager,'admin')
  const first=await sent(manager.email,'invite')
  assert.equal(first.path,'/aceitar-convite')
  assert.equal((await accept(outsider,first.token)).status,400)
  assert.equal((await call(team(one)+'/invites/'+managerInvite+'/resend',owner.cookie,{})).status,204)
  assert.equal((await accept(manager,first.token)).status,400)
  const second=await sent(manager.email,'invite')
  assert.equal((await accept(manager,second.token)).status,200)
  assert.equal((await accept(manager,second.token)).status,409)
  assert.equal((await call(team(one)+'/invites',manager.cookie,{email:outsider.email,role:'owner'})).status,403)
  const revoked=await invite(owner,one,outsider,'viewer')
  const third=await sent(outsider.email,'invite')
  assert.equal((await call(team(one)+'/invites/'+revoked+'/revoke',owner.cookie,{})).status,204)
  assert.equal((await accept(outsider,third.token)).status,400)
  for(const [member,role] of [[operator,'finance'],[reader,'viewer']] as const){
    await invite(manager,one,member,role)
    assert.equal((await accept(member,(await sent(member.email,'invite')).token)).status,200)
  }
  await invite(owner,two,reader,'viewer')
  assert.equal((await accept(reader,(await sent(reader.email,'invite')).token)).status,200)
  assert.equal(((await (await call('tenant/companies',reader.cookie)).json()) as unknown[]).length,2)
  const directory=await (await call('tenant/companies?q=Empresa+B&page=1',reader.cookie)).json() as {items:{id:string}[]}
  assert.deepEqual(directory.items.map(item=>item.id),[two])
  const change=team(one)+'/members/'+owner.id
  assert.equal((await call(change,manager.cookie,{role:'viewer',active:false})).status,403)
  assert.equal((await call(change,owner.cookie,{role:'owner',active:false})).status,409)
  const client=await idFor(await call(team(one)+'/clients',operator.cookie,{name:'Cliente A'}))
  assert.equal((await call(team(one)+'/clients',reader.cookie,{name:'Bloqueado'})).status,403)
  assert.equal((await call(team(two)+'/clients/'+client,reader.cookie)).status,404)
  assert.equal((await call(team(two)+'/charges',owner.cookie,{description:'Troca de IDs',clientId:client,amount:300})).status,404)
  assert.equal((await call(team(one)+'/clients/'+client,reader.cookie,{name:'Bloqueado'})).status,403)
  assert.equal((await call(team(two)+'/clients/'+client,owner.cookie,{name:'Outro ambiente'})).status,404)
  assert.equal((await call(team(one)+'/clients/'+client,operator.cookie,{name:'Cliente A revisado',email:'Contato@example.test'})).status,204)
  const edited=await (await call(team(one)+'/clients/'+client,reader.cookie)).json() as {name:string;email:string}
  assert.equal(edited.name,'Cliente A revisado')
  assert.equal(edited.email,'contato@example.test')
  assert.equal((await call(team(one)+'/clients',outsider.cookie)).status,404)
  assert.equal((await call(team(one)+'/clients')).status,401)
  assert.equal((await call(team(one)+'/team',operator.cookie)).status,403)
  assert.equal((await call(team(one)+'/simulate',reader.cookie,{chargeId:randomUUID(),scenario:'correct'})).status,403)
  for(const tenantId of [one,two]){
    const response=await call(team(tenantId)+'/clients?q=Cliente',reader.cookie)
    assert.equal(response.status,200)
    assert.equal((await response.json() as {items:unknown[]}).items.length,tenantId===one?1:0)
  }
  await call(team(one)+'/clients?q=Cliente',reader.cookie)
  assert.ok(tenant.cacheMetrics.hit>0)
  assert.equal((await call(team(one)+'/members/'+reader.id,manager.cookie,{role:'viewer',active:false})).status,204)
  assert.equal((await call(team(one)+'/clients?q=Cliente',reader.cookie)).status,404)
  assert.equal((await call(team(two)+'/clients?q=Cliente',reader.cookie)).status,200)
  await invite(owner,one,outsider,'owner')
  assert.equal((await accept(outsider,(await sent(outsider.email,'invite')).token)).status,200)
  const owners=await Promise.all([
    call(change,owner.cookie,{role:'viewer',active:true}),
    call(team(one)+'/members/'+outsider.id,outsider.cookie,{role:'viewer',active:true}),
  ])
  assert.deepEqual(owners.map(item=>item.status).sort(),[204,409])
  await assert.rejects(pool.query('DELETE FROM tenant_audit WHERE true'))
})

test('webhook durável, concorrência, reenvio, conflito, divergência, extra, resolução e cache com falha',async()=>{
  const owner=await person('pay-owner')
  const one=await company(owner,'Financeira'),two=await company(owner,'Separada')
  const root=team(one)
  const charge=await idFor(await call(root+'/charges',owner.cookie,{description:'Cobrança inicial',amount:5000}))
  await call(root+'/overview',owner.cookie)
  const payload=(await pool.query("SELECT id FROM tenant_providers WHERE company_id=$1",[one])).rows[0]
  const body={providerId:payload.id,chargeId:charge,eventId:randomUUID(),paymentId:randomUUID(),amount:5000}
  const deliver=(details:object)=>call('tenant/webhook/simulator','',details,{Authorization:'Bearer '+simulator.secret})
  assert.equal((await call('tenant/webhook/simulator','',body)).status,401)
  const race=await Promise.all([deliver(body),deliver(body)])
  assert.deepEqual(race.map(item=>item.status),[200,200])
  const outcomes=await Promise.all(race.map(item=>item.json() as Promise<{id:string;outcome:string}>))
  assert.deepEqual(outcomes.map(item=>item.outcome).sort(),['duplicate','settled'])
  assert.equal((await deliver({...body,amount:5001})).status,409)
  const detail=await call(root+'/events/'+outcomes[0].id,owner.cookie)
  assert.equal((await detail.json() as {deliveries:{outcome:string}[]}).deliveries.length,3)
  assert.equal((await call(team(two)+'/events/'+outcomes[0].id,owner.cookie)).status,404)
  const repeatedPayment=await deliver({...body,eventId:randomUUID()})
  assert.equal(repeatedPayment.status,200)
  assert.equal((await repeatedPayment.json() as {outcome:string}).outcome,'duplicate')
  assert.equal((await pool.query('SELECT count(*)::int n FROM tenant_payments WHERE company_id=$1',[one])).rows[0].n,1)
  assert.equal((await call(root+'/simulate',owner.cookie,{chargeId:charge,scenario:'extra',requestKey:randomUUID()})).status,200)
  const divergent=await idFor(await call(root+'/charges',owner.cookie,{description:'Cobrança em revisão',amount:6000}))
  assert.equal((await call(root+'/simulate',owner.cookie,{chargeId:divergent,scenario:'different',requestKey:randomUUID()})).status,200)
  const foreignCharge=await idFor(await call(team(two)+'/charges',owner.cookie,{description:'Cobrança da outra empresa',amount:5000}))
  const misplaced=await deliver({...body,chargeId:foreignCharge,eventId:randomUUID(),paymentId:randomUUID()})
  assert.equal(misplaced.status,200)
  assert.equal((await misplaced.json() as {outcome:string}).outcome,'unmatched')
  assert.equal((await (await call(team(two)+'/charges/'+foreignCharge,owner.cookie)).json() as {status:string}).status,'pending')
  const list=await (await call(root+'/reviews',owner.cookie)).json() as {items:{id:string;reason:string}[]}
  assert.deepEqual(list.items.map(item=>item.reason).sort(),['divergent','extra','unmatched'])
  assert.equal((await call(root+'/charges/'+divergent,owner.cookie)).status,200)
  const state=await (await call(root+'/charges/'+divergent,owner.cookie)).json() as {status:string}
  assert.equal(state.status,'pending')
  for(const row of list.items){
    const action=row.reason==='divergent'?'settle':row.reason==='extra'?'refund_recorded':'close'
    assert.equal((await call(root+'/reviews/'+row.id+'/resolve',owner.cookie,{action,justification:'Justificativa auditável'})).status,204)
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM tenant_payments WHERE company_id=$1 AND settled',[one])).rows[0].n,2)
  const values=await (await call(root+'/overview',owner.cookie)).json() as {paid:string;reviews:number}
  assert.equal(values.paid,'10999');assert.equal(values.reviews,0)
  assert.equal((await (await call(team(two)+'/overview',owner.cookie)).json() as {paid:string}).paid,'0')
  await pool.query('ALTER TABLE tenant_cache RENAME TO tenant_cache_offline')
  try {
    const fallback=await call(root+'/overview',owner.cookie)
    assert.equal(fallback.status,200)
    assert.equal((await fallback.json() as {paid:string}).paid,'10999')
    assert.ok(tenant.cacheMetrics.error>0)
  }finally{await pool.query('ALTER TABLE tenant_cache_offline RENAME TO tenant_cache')}
})


test('falha ao persistir entrega reverte baixa, pagamento e evento, permitindo reenvio',async()=>{
  const owner=await person('rollback-pay')
  const companyId=await company(owner,'Empresa de rollback')
  const root=team(companyId)
  const chargeId=await idFor(await call(root+'/charges',owner.cookie,{description:'Cobrança para rollback',amount:900}))
  const {rows:[provider]}=await pool.query('SELECT id FROM tenant_providers WHERE company_id=$1',[companyId])
  const body={providerId:provider.id,chargeId,eventId:randomUUID(),paymentId:randomUUID(),amount:900}
  const send=()=>call('tenant/webhook/simulator','',body,{Authorization:'Bearer '+simulator.secret})
  await pool.query('ALTER TABLE tenant_deliveries ADD CONSTRAINT fail_delivery CHECK (false) NOT VALID')
  const previous=console.error
  console.error=()=>undefined
  try {
    assert.equal((await send()).status,500)
    const {rows:[state]}=await pool.query(`SELECT status,
      (SELECT count(*)::int FROM tenant_payments WHERE company_id=$1) payments,
      (SELECT count(*)::int FROM tenant_events WHERE company_id=$1) events
      FROM tenant_charges WHERE company_id=$1 AND id=$2`,[companyId,chargeId])
    assert.deepEqual(state,{status:'pending',payments:0,events:0})
  } finally {
    console.error=previous
    await pool.query('ALTER TABLE tenant_deliveries DROP CONSTRAINT fail_delivery')
  }
  assert.equal((await send()).status,200)
  assert.equal((await send()).status,200)
  assert.equal((await pool.query('SELECT count(*)::int n FROM tenant_payments WHERE company_id=$1 AND settled',[companyId])).rows[0].n,1)
})


