import { requestId } from './audit'
import { timingSafeEqual } from 'node:crypto'
import { Body,Controller,Get,HttpCode,Inject,Param,Post,Query,Req,Res } from '@nestjs/common'
import type { Request,Response } from 'express'
import { Account } from './account'
import { Finance,resource } from './finance'
import { Identity,PublicError } from './identity'
import { Sessions,sessionIdPattern } from './sessions'
import { conflict,missing,Tenants,uuid } from './tenants'

export const domainOptions=Symbol('domainOptions')
export type DomainOptions={origins:string[];production:boolean;simulatorSecret?:string}
function csrf(request:Request,options:DomainOptions){
  if(!request.headers.origin||!options.origins.includes(request.headers.origin)||request.get('X-ConciliaPix-CSRF')!=='1'){
    throw new PublicError(403,'REQUEST_ORIGIN_DENIED','Origem não autorizada.')
  }
}
function cookieName(production:boolean){return production?'__Host-conciliapix_session':'conciliapix_session'}
function clear(response:Response,options:DomainOptions){
  response.clearCookie(cookieName(options.production),{httpOnly:true,secure:options.production,sameSite:'lax',path:'/'})
}
async function auth(request:Request,sessions:Sessions,options:DomainOptions){
  const origin=request.headers.origin
  const fetchSite=request.get('Sec-Fetch-Site')
  if (origin ? !options.origins.includes(origin) : fetchSite==='cross-site'||fetchSite==='same-site') {
    throw new PublicError(403,'REQUEST_ORIGIN_DENIED','Origem não autorizada.')
  }
  const key=cookieName(options.production)+'='
  const matches=request.headers.cookie?.split(';').map(item=>item.trim()).filter(item=>item.startsWith(key))??[]
  const token=matches.length===1?matches[0].slice(key.length):''
  const user=sessionIdPattern.test(token)?await sessions.current(token):undefined
  if(!user) throw new PublicError(401,'SESSION_REQUIRED','Entre novamente para continuar.')
  return {user,token}
}

@Controller('api/identity')
export class AccountController {
  constructor(private account:Account,private identity:Identity,private sessions:Sessions,@Inject(domainOptions) private options:DomainOptions){}
  @Post('password/request') @HttpCode(202)
  async requestReset(@Req() request:Request,@Body() body:unknown){
    await this.identity.limit('reset_request',request.ip??'unknown')
    await this.account.requestReset(body)
    return {message:'Se for possível recuperar a conta, você receberá um e-mail.'}
  }
  @Post('password/reset') @HttpCode(204)
  async reset(@Req() request:Request,@Body() body:unknown){
    await this.identity.limit('reset',request.ip??'unknown')
    await this.account.reset(body)
  }
  @Post('password/change') @HttpCode(204)
  async change(@Req() request:Request,@Res({passthrough:true}) response:Response,@Body() body:unknown){
    csrf(request,this.options)
    await this.identity.limit('password_change',request.ip??'unknown')
    const {user,token}=await auth(request,this.sessions,this.options)
    await this.account.change(user.id,token,body)
    clear(response,this.options)
  }
  @Post('profile') @HttpCode(204)
  async profile(@Req() request:Request,@Body() body:unknown){
    csrf(request,this.options)
    await this.account.updateName((await auth(request,this.sessions,this.options)).user.id,body)
  }
  @Post('sessions/revoke-others') @HttpCode(204)
  async revoke(@Req() request:Request){
    csrf(request,this.options)
    const {user,token}=await auth(request,this.sessions,this.options)
    await this.account.revokeOthers(user.id,token)
  }
}
@Controller('api/tenant')
export class TenantController {
  constructor(private tenants:Tenants,private finance:Finance,private sessions:Sessions,@Inject(domainOptions) private options:DomainOptions){}
  private async user(request:Request,write=false){
    if(write) csrf(request,this.options)
    return (await auth(request,this.sessions,this.options)).user
  }
  @Get('companies') async list(@Req() req:Request,@Query() query:Record<string,unknown>){return this.tenants.list((await this.user(req)).id,query)}
  @Post('companies') async create(@Req() req:Request,@Body() body:unknown){return this.tenants.create((await this.user(req,true)).id,body)}
  @Post('invites/accept') @HttpCode(200)
  async accept(@Req() req:Request,@Body() body:unknown){return this.tenants.accept(await this.user(req,true),body)}
  @Get('companies/:company')
  async detail(@Req() req:Request,@Param('company') company:string){
    return {...await this.tenants.detail(company,(await this.user(req)).id),simulator:Boolean(this.options.simulatorSecret)}
  }
  @Post('companies/:company') @HttpCode(200)
  async rename(@Req() req:Request,@Param('company') company:string,@Body() body:unknown){return this.tenants.rename(company,(await this.user(req,true)).id,body)}
  @Get('companies/:company/team')
  async team(@Req() req:Request,@Param('company') company:string,@Query() query:Record<string,unknown>){
    return this.tenants.team(company,(await this.user(req)).id,query)
  }
  @Post('companies/:company/invites')
  async invite(@Req() req:Request,@Param('company') company:string,@Body() body:unknown){return this.tenants.invite(company,(await this.user(req,true)).id,body)}
  @Post('companies/:company/invites/:id/:action') @HttpCode(204)
  async inviteAction(@Req() req:Request,@Param('company') company:string,@Param('id') id:string,@Param('action') action:string){
    await this.tenants.updateInvite(company,(await this.user(req,true)).id,id,action)
  }
  @Post('companies/:company/members/:id') @HttpCode(204)
  async member(@Req() req:Request,@Param('company') company:string,@Param('id') id:string,@Body() body:unknown){
    await this.tenants.changeMember(company,(await this.user(req,true)).id,id,body)
  }
  @Get('companies/:company/overview')
  async overview(@Req() req:Request,@Param('company') company:string,@Query('days') days:unknown){return this.finance.overview(company,(await this.user(req)).id,days)}
  @Post('companies/:company/simulate') @HttpCode(200)
  async simulate(@Req() req:Request,@Param('company') company:string,@Body() body:unknown){return this.finance.simulate(company,(await this.user(req,true)).id,body)}
  @Post('companies/:company/reviews/:id/resolve') @HttpCode(204)
  async resolve(@Req() req:Request,@Param('company') company:string,@Param('id') id:string,@Body() body:unknown){
    await this.finance.resolve(company,(await this.user(req,true)).id,id,body)
  }
  @Get('companies/:company/:kind')
  async records(@Req() req:Request,@Param('company') company:string,@Param('kind') kind:string,@Query() query:Record<string,unknown>){
    return this.finance.list(company,(await this.user(req)).id,resource(kind),query)
  }
  @Get('companies/:company/:kind/:id')
  async record(@Req() req:Request,@Param('company') company:string,@Param('kind') kind:string,@Param('id') id:string){
    return this.finance.detail(company,(await this.user(req)).id,resource(kind),id)
  }
  @Post('companies/:company/clients/:id') @HttpCode(204)
  async editClient(@Req() req:Request,@Param('company') company:string,@Param('id') id:string,@Body() body:unknown){
    await this.finance.editClient(company,(await this.user(req,true)).id,id,body)
  }
  @Post('companies/:company/:kind')
  async newRecord(@Req() req:Request,@Param('company') company:string,@Param('kind') kind:string,@Body() body:unknown){
    if(kind!=='clients'&&kind!=='charges') throw missing()
    return this.finance.create(company,(await this.user(req,true)).id,kind,body)
  }
  @Post('webhook/simulator') @HttpCode(200)
  async webhook(@Req() req:Request,@Body() body:unknown){
    if(!this.options.simulatorSecret) throw missing()
    const expected=Buffer.from('Bearer '+this.options.simulatorSecret)
    const received=Buffer.from(req.get('Authorization')??'')
    if(expected.length!==received.length||!timingSafeEqual(expected,received)) throw new PublicError(401,'INVALID_PROVIDER','Integração não autorizada.')
    const correlation=req.get('X-Correlation-Id')
    const result=correlation?await requestId.run(uuid(correlation),()=>this.finance.webhook(body)):await this.finance.webhook(body)
    if(result.outcome==='conflict') throw conflict('Identificador recebido com conteúdo conflitante.')
    return result
  }
}



