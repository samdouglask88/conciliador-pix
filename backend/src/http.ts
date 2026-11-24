import { randomUUID } from 'node:crypto'
import { requestId } from './audit'
import { Account } from './account'
import { Finance } from './finance'
import { Tenants } from './tenants'
import { AccountController, TenantController, domainOptions } from './domain-http'
import 'reflect-metadata'
import {
  ArgumentsHost, Body, Catch, Controller, type ExceptionFilter, HttpCode, HttpException, Module, Post, Req,
} from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import type { NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import { Identity, PublicError } from './identity'
import { SessionController, sessionHttpOptions } from './session-http'
import { Sessions } from './sessions'

const accepted = { message: 'Se for possível enviar um link de confirmação, você receberá um e-mail.' }

@Controller('api/identity')
class IdentityController {
  constructor(private readonly identity: Identity) {}

  @Post('register')
  @HttpCode(202)
  async register(@Req() request: Request, @Body() input: unknown) {
    await this.identity.limit('register', request.ip ?? 'unknown')
    await this.identity.register(input)
    return accepted
  }

  @Post('resend')
  @HttpCode(202)
  async resend(@Req() request: Request, @Body() input: unknown) {
    await this.identity.limit('resend', request.ip ?? 'unknown')
    await this.identity.resend(input)
    return accepted
  }

  @Post('confirm')
  @HttpCode(200)
  async confirm(@Req() request: Request, @Body() input: unknown) {
    await this.identity.limit('confirm', request.ip ?? 'unknown')
    await this.identity.confirm(input)
    return { message: 'E-mail confirmado.' }
  }
}

@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>()
    if (error instanceof PublicError) {
      response.status(error.status).json({ code: error.code, message: error.message })
      return
    }
    const parserError = error && typeof error === 'object' && 'type' in error ? error.type : undefined
    const parserStatus = parserError === 'entity.too.large' ? 413
      : parserError === 'entity.parse.failed' || parserError === 'request.size.invalid' ? 400
      : parserError === 'charset.unsupported' || parserError === 'encoding.unsupported' ? 415 : 500
    const status = error instanceof HttpException ? error.getStatus() : parserStatus
    const known: Record<number, [string, string]> = {
      400: ['INVALID_INPUT', 'O conteúdo da solicitação é inválido.'],
      404: ['NOT_FOUND', 'Endpoint não encontrado.'],
      413: ['PAYLOAD_TOO_LARGE', 'A solicitação excede o tamanho permitido.'],
      415: ['UNSUPPORTED_MEDIA_TYPE', 'Envie o conteúdo como JSON.'],
    }
    const [code, message] = known[status] ?? ['INTERNAL_ERROR', 'Não foi possível concluir a solicitação.']
    if (status >= 500) {
      const path = host.switchToHttp().getRequest<Request>().path
      const action = /^\/api\/identity\/(register|resend|confirm|login|session|logout)\/?$/i.exec(path)?.[1].toLowerCase() ?? /^\/api\/tenant\/(companies|invites|webhook)(?:\/|$)/.exec(path)?.[1] ?? 'other'
      const candidate = error && typeof error==='object' && 'code' in error ? error.code : undefined
      const sqlState = typeof candidate==='string' && /^[0-9A-Z]{5}$/.test(candidate) ? candidate : undefined
      console.error('identity_api_failure', { action, status, correlation: requestId.getStore(), sqlState })
    }
    response.status(status).json({ code, message })
  }
}

export async function createApp(identity: Identity, production = false, proxies: string[] = [],
  session?: { service: Sessions; origins: string[]; domain?: { account: Account; tenants: Tenants; finance: Finance; simulatorSecret?: string } }) {
  @Module({
    controllers: [IdentityController, ...(session ? [SessionController] : []), ...(session?.domain ? [AccountController, TenantController] : [])],
    providers: [
      ...(session?.domain ? [
        {provide: Account,useValue:session.domain.account}, {provide: Tenants,useValue:session.domain.tenants},
        {provide: Finance,useValue:session.domain.finance},
        {provide: domainOptions,useValue:{production, origins:session.origins, simulatorSecret:session.domain.simulatorSecret}},
      ] : []),
      { provide: Identity, useValue: identity },
      ...(session ? [{ provide: Sessions, useValue: session.service },
        { provide: sessionHttpOptions, useValue: { production, origins: session.origins } }] : []),
    ],
  })
  class ApiModule {}
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    logger: false, abortOnError: false, bodyParser: false,
  })
  if (proxies.length) app.set('trust proxy', proxies)
  if (session) app.enableCors({
    origin: session.origins, credentials: true, methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-ConciliaPix-CSRF'],
  })
  app.use(helmet({ strictTransportSecurity: production ? undefined : false }))
  app.use((request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store')
    const correlation = randomUUID()
    response.setHeader('X-Request-Id', correlation)
    if (production && !request.secure) return response.status(426).json({
      code: 'HTTPS_REQUIRED', message: 'Use HTTPS para acessar a API.',
    })
    if (request.method === 'POST' && /^\/api\/(identity|tenant)\//i.test(request.path) && !request.is('application/json')) {
      return response.status(415).json({ code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Envie o conteúdo como JSON.' })
    }
    requestId.run(correlation,next)
  })
  app.useBodyParser('json', { limit: '8kb' })
  app.useGlobalFilters(new SafeErrors())
  return app
}







