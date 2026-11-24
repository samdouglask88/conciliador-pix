import { randomUUID } from 'node:crypto'
import type { Pool,PoolClient } from 'pg'
import { audit } from './audit'
import { transaction } from './db'
import { bodyObject,normalizeEmail,PublicError } from './identity'
import { enqueueToken } from './mail-token'
import { ConfirmationTokens,hashToken } from './tokens'

export type Role = 'owner'|'admin'|'finance'|'viewer'
const roles = ['owner','admin','finance','viewer']
export const bad = (message: string) => new PublicError(400,'INVALID_INPUT',message)
export const missing = () => new PublicError(404,'NOT_FOUND','Registro não encontrado.')
export const denied = () => new PublicError(403,'FORBIDDEN','Você não tem permissão para esta ação.')
export const conflict = (message: string) => new PublicError(409,'CONFLICT',message)
export function uuid(value: unknown): string {
  if (typeof value!=='string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw bad('Identificador inválido.')
  return value.toLowerCase()
}
export function textField(value: unknown,max=120,min=2): string {
  if(typeof value!=='string'||value.trim().length<min||value.length>max||/[\x00-\x1f\x7f]/.test(value)) throw bad('Texto inválido.')
  return value.trim()
}
export function cents(value: unknown): number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>1000000000) throw bad('Informe o valor em centavos, de 1 a 1.000.000.000.')
  return value
}
function roleField(value: unknown): Role {
  if(typeof value!=='string'||!roles.includes(value)) throw bad('Papel inválido.')
  return value as Role
}
function manage(actor: Role, role: Role) {
  if(actor!=='owner' && (actor!=='admin'||!['finance','viewer'].includes(role))) throw denied()
}
type Permission = 'read'|'operate'|'manage'
type Scope = { id: string; name: string; version: string; role: Role }

export class Tenants {
  readonly cacheMetrics = { hit:0,miss:0,error:0,loadMs:0 }
  constructor(private pool: Pool,private keys: ConfirmationTokens) {}

  async list(user:string,query:Record<string,unknown>={}){
    const base=`SELECT c.id,c.name,m.role FROM tenant_members m JOIN tenant_companies c ON c.id=m.company_id
      WHERE m.user_id=$1 AND m.active`
    if(query.q===undefined&&query.page===undefined){
      return (await this.pool.query(base+' ORDER BY c.name,c.id',[user])).rows
    }
    const q=query.q===undefined||query.q===''?'':textField(query.q,120,1)
    const page=query.page===undefined?'1':query.page
    if(typeof page!=='string'||!/^\d{1,5}$/.test(page)||Number(page)<1) throw bad('Página inválida.')
    const pattern='%'+q.replace(/[\\%_]/g,char=>'\\'+char)+'%'
    const {rows}=await this.pool.query(base+' AND c.name ILIKE $2 ORDER BY c.name,c.id LIMIT 21 OFFSET $3',
      [user,pattern,(Number(page)-1)*20])
    return {items:rows.slice(0,20),page:Number(page),hasMore:rows.length>20}
  }
  create(user: string,input: unknown) {
    const body=bodyObject(input), name=textField(body.name), request=uuid(body.requestKey)
    return transaction(this.pool,async db=>{
      const id=randomUUID()
      const {rows:[created]}=await db.query(`INSERT INTO tenant_companies(id,name,created_by,request_key) VALUES($1,$2,$3,$4)
        ON CONFLICT(created_by,request_key) DO NOTHING RETURNING id,name`,[id,name,user,request])
      if(!created){
        const { rows:[existing] }=await db.query('SELECT id,name FROM tenant_companies WHERE created_by=$1 AND request_key=$2',[user,request])
        const member=await db.query('SELECT 1 FROM tenant_members WHERE company_id=$1 AND user_id=$2 AND active',[existing.id,user])
        if(!member.rowCount) throw missing()
        if(existing.name!==name) throw conflict('A chave já foi usada para outra solicitação.')
        return existing
      }
      await db.query("INSERT INTO tenant_members(company_id,user_id,role) VALUES($1,$2,'owner')",[id,user])
      await db.query("INSERT INTO tenant_providers(id,company_id,kind) VALUES($1,$2,'simulator')",[randomUUID(),id])
      await audit(db,id,user,'company.create',id)
      return created
    })
  }
  scope<T>(company: string,user: string,permission: Permission,write: boolean,fn:(db:PoolClient,scope:Scope)=>Promise<T>) {
    return transaction(this.pool,async db=>{
      const {rows:[record]}=await db.query<Omit<Scope,'role'>>(
        'SELECT id,name,version FROM tenant_companies WHERE id=$1 FOR '+(write?'UPDATE':'SHARE'),[uuid(company)])
      if(!record) throw missing()
      const {rows:[member]}=await db.query<{role:Role}>('SELECT role FROM tenant_members WHERE company_id=$1 AND user_id=$2 AND active',[company,user])
      if(!member) throw missing()
      if(permission==='manage'&&!['owner','admin'].includes(member.role)||permission==='operate'&&member.role==='viewer') throw denied()
      const result=await fn(db,{...record,role:member.role})
      if(write) await db.query('UPDATE tenant_companies SET version=version+1 WHERE id=$1',[company])
      return result
    })
  }
  async cached<T>(db:PoolClient,scope:Scope,key:string,load:()=>Promise<T>):Promise<T>{
    await db.query('SAVEPOINT cache_io')
    try {
      const {rows:[cached]}=await db.query('SELECT value FROM tenant_cache WHERE company_id=$1 AND key=$2 AND version=$3 AND expires_at>now()',
        [scope.id,key,scope.version])
      if(cached){ this.cacheMetrics.hit++; await db.query('RELEASE SAVEPOINT cache_io'); return cached.value as T }
    } catch { this.cacheMetrics.error++; await db.query('ROLLBACK TO SAVEPOINT cache_io') }
    await db.query('RELEASE SAVEPOINT cache_io')
    this.cacheMetrics.miss++
    const started=performance.now()
    const value=await load()
    this.cacheMetrics.loadMs+=performance.now()-started
    await db.query('SAVEPOINT cache_io')
    try {
      await db.query(`INSERT INTO tenant_cache(company_id,key,version,value,expires_at)
        VALUES($1,$2,$3,$4::jsonb,now()+interval '45 seconds')
        ON CONFLICT(company_id,key) DO UPDATE SET version=excluded.version,value=excluded.value,expires_at=excluded.expires_at`,
      [scope.id,key,scope.version,JSON.stringify(value)])
    } catch { this.cacheMetrics.error++; await db.query('ROLLBACK TO SAVEPOINT cache_io') }
    await db.query('RELEASE SAVEPOINT cache_io')
    return value
  }
  detail(company:string,user:string){
    return this.scope(company,user,'read',false,async(db,scope)=>({
      ...await this.cached(db,scope,'company',async()=>({id:scope.id,name:scope.name})),role:scope.role
    }))
  }
  rename(company:string,user:string,input:unknown){
    const name=textField(bodyObject(input).name)
    return this.scope(company,user,'manage',true,async db=>{
      await db.query('UPDATE tenant_companies SET name=$2 WHERE id=$1',[company,name])
      await audit(db,company,user,'company.rename',company)
      return {id:company,name}
    })
  }
  team(company:string,user:string,query:Record<string,unknown>={}){
    const q=query.q===undefined||query.q===''?'':textField(query.q,120,1)
    const page=query.page===undefined?'1':query.page
    if(typeof page!=='string'||!/^\d{1,5}$/.test(page)||Number(page)<1) throw bad('Página inválida.')
    const pattern='%'+q.replace(/[\\%_]/g,char=>'\\'+char)+'%'
    const filters=[company,pattern,(Number(page)-1)*20]
    return this.scope(company,user,'manage',false,async db=>{
      const members=(await db.query(`SELECT u.id,u.name,u.email,m.role,m.active
        FROM tenant_members m JOIN identity_users u ON u.id=m.user_id
        WHERE m.company_id=$1 AND (u.name ILIKE $2 OR u.email ILIKE $2)
        ORDER BY u.name,u.id LIMIT 21 OFFSET $3`,filters)).rows
      const invites=(await db.query(`SELECT i.id,i.email,i.role,i.status,i.created_at,t.expires_at FROM tenant_invites i
        JOIN identity_email_tokens t ON t.id=i.token_id WHERE i.company_id=$1 AND i.email ILIKE $2
        ORDER BY i.created_at DESC,i.id LIMIT 21 OFFSET $3`,filters)).rows
      return {members:members.slice(0,20),invites:invites.slice(0,20),hasMore:members.length>20||invites.length>20}
    })
  }
  invite(company:string,user:string,input:unknown){
    const body=bodyObject(input),email=normalizeEmail(body.email),role=roleField(body.role)
    return this.scope(company,user,'manage',true,async(db,scope)=>{
      manage(scope.role,role)
      const existing=await db.query(`SELECT 1 FROM tenant_members m JOIN identity_users u ON u.id=m.user_id
        WHERE m.company_id=$1 AND u.email=$2 AND m.active`,[company,email])
      if(existing.rowCount) throw conflict('Já existe um vínculo ativo para este e-mail.')
      if((await db.query("SELECT 1 FROM tenant_invites WHERE company_id=$1 AND email=$2 AND status='pending'",[company,email])).rowCount){
        throw conflict('Já existe convite pendente. Use reenviar ou revogar.')
      }
      const id=randomUUID(),token=await enqueueToken(db,this.keys,'invite',{recipient:email},7*86400)
      await db.query('INSERT INTO tenant_invites(id,company_id,email,role,token_id) VALUES($1,$2,$3,$4,$5)',[id,company,email,role,token])
      await audit(db,company,user,'invite.create',id)
      return {id}
    })
  }
  updateInvite(company:string,user:string,id:string,action:string){
    if(action!=='resend'&&action!=='revoke') throw bad('Ação inválida.')
    return this.scope(company,user,'manage',true,async(db,scope)=>{
      const {rows:[invite]}=await db.query("SELECT * FROM tenant_invites WHERE company_id=$1 AND id=$2 AND status='pending'",[company,uuid(id)])
      if(!invite) throw missing()
      manage(scope.role,invite.role)
      await db.query('UPDATE identity_email_tokens SET invalidated_at=clock_timestamp() WHERE id=$1',[invite.token_id])
      if(action==='revoke') await db.query("UPDATE tenant_invites SET status='revoked' WHERE id=$1",[id])
      else {
        const token=await enqueueToken(db,this.keys,'invite',{recipient:invite.email},7*86400)
        await db.query('UPDATE tenant_invites SET token_id=$2 WHERE id=$1',[id,token])
      }
      await audit(db,company,user,'invite.'+action,id)
    })
  }
  accept(user:{id:string;email:string},input:unknown){
    const token=bodyObject(input).token
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)) throw bad('Convite inválido.')
    return transaction(this.pool,async db=>{
      const hash=hashToken(token)
      const {rows:[link]}=await db.query(`SELECT i.company_id FROM tenant_invites i JOIN identity_email_tokens t ON t.id=i.token_id
        WHERE t.token_hash=$1 AND t.purpose='invite'`,[hash])
      if(!link) throw bad('Convite inválido ou substituído.')
      await db.query('SELECT id FROM tenant_companies WHERE id=$1 FOR UPDATE',[link.company_id])
      const {rows:[invite]}=await db.query(`SELECT i.*, t.expires_at<=clock_timestamp() expired,t.consumed_at,t.invalidated_at
        FROM tenant_invites i JOIN identity_email_tokens t ON t.id=i.token_id
        WHERE i.company_id=$1 AND t.token_hash=$2 AND t.purpose='invite'`,[link.company_id,hash])
      if(!invite||invite.status==='revoked'||invite.invalidated_at||invite.email!==user.email) throw bad('Convite inválido para este e-mail.')
      if(invite.status==='accepted'||invite.consumed_at) throw conflict('Este convite já foi utilizado.')
      if(invite.expired) throw new PublicError(410,'TOKEN_EXPIRED','O convite expirou.')
      await db.query(`INSERT INTO tenant_members(company_id,user_id,role) VALUES($1,$2,$3)
        ON CONFLICT(company_id,user_id) DO UPDATE SET active=true,role=excluded.role WHERE NOT tenant_members.active`,
      [invite.company_id,user.id,invite.role])
      await db.query("UPDATE tenant_invites SET status='accepted' WHERE id=$1",[invite.id])
      await db.query('UPDATE identity_email_tokens SET consumed_at=clock_timestamp() WHERE id=$1',[invite.token_id])
      await db.query('UPDATE tenant_companies SET version=version+1 WHERE id=$1',[invite.company_id])
      await audit(db,invite.company_id,user.id,'invite.accept',invite.id)
      return {companyId:invite.company_id}
    })
  }
  changeMember(company:string,user:string,id:string,input:unknown){
    const body=bodyObject(input),role=roleField(body.role)
    if(typeof body.active!=='boolean') throw bad('Informe o estado do vínculo.')
    return this.scope(company,user,'manage',true,async(db,scope)=>{
      const {rows:[target]}=await db.query('SELECT role,active FROM tenant_members WHERE company_id=$1 AND user_id=$2',[company,uuid(id)])
      if(!target) throw missing()
      manage(scope.role,target.role); manage(scope.role,role)
      if(target.active&&target.role==='owner'&&(role!=='owner'||!body.active)){
        const {rows:[other]}=await db.query("SELECT count(*)::int n FROM tenant_members WHERE company_id=$1 AND active AND role='owner' AND user_id<>$2",[company,id])
        if(!other.n) throw conflict('A empresa precisa manter um proprietário ativo.')
      }
      await db.query('UPDATE tenant_members SET role=$3,active=$4 WHERE company_id=$1 AND user_id=$2',[company,id,role,body.active])
      await audit(db,company,user,'member.update',id)
    })
  }
}



