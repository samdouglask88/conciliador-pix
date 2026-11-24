import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { PublicError } from './identity'
import { Sessions, sessionIdPattern, sessionPolicy } from './sessions'

export const sessionHttpOptions = Symbol('sessionHttpOptions')
export type SessionHttpOptions = { production: boolean; origins: readonly string[] }

@Controller('api/identity')
export class SessionController {
  constructor(private readonly sessions: Sessions,
    @Inject(sessionHttpOptions) private readonly options: SessionHttpOptions) {}

  private get cookieName() {
    return this.options.production ? '__Host-conciliapix_session' : 'conciliapix_session'
  }

  private get cookieOptions() {
    return { httpOnly: true, secure: this.options.production, sameSite: 'lax' as const, path: '/' }
  }

  private readCookie(request: Request) {
    const matches = request.headers.cookie?.split(';')
      .map(part => part.trim()).filter(part => part.startsWith(this.cookieName + '=')) ?? []
    const value = matches.length === 1 ? matches[0].slice(this.cookieName.length + 1) : ''
    return { token: sessionIdPattern.test(value) ? value : undefined, present: matches.length > 0 }
  }

  private requireCsrf(request: Request) {
    if (!request.headers.origin || !this.options.origins.includes(request.headers.origin) ||
      request.get('X-ConciliaPix-CSRF') !== '1') {
      throw new PublicError(403, 'REQUEST_ORIGIN_DENIED', 'A solicitação não veio de uma origem autorizada.')
    }
  }

  @Post('login')
  @HttpCode(204)
  async login(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() input: unknown) {
    this.requireCsrf(request)
    const token = await this.sessions.login(input, request.ip ?? 'unknown', this.readCookie(request).token)
    response.cookie(this.cookieName, token, { ...this.cookieOptions, maxAge: sessionPolicy.absoluteSeconds * 1000 })
  }

  @Get('session')
  async current(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const origin = request.headers.origin
    const fetchSite = request.get('Sec-Fetch-Site')
    if (origin ? !this.options.origins.includes(origin) : fetchSite === 'cross-site' || fetchSite === 'same-site') {
      throw new PublicError(403, 'REQUEST_ORIGIN_DENIED', 'A solicitação não veio de uma origem autorizada.')
    }
    const { token, present } = this.readCookie(request)
    const user = await this.sessions.current(token)
    if (!user) {
      if (present) response.clearCookie(this.cookieName, this.cookieOptions)
      throw new PublicError(401, present ? 'SESSION_INVALID' : 'SESSION_REQUIRED', 'Entre para acessar sua conta.')
    }
    return { user }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.requireCsrf(request)
    await this.sessions.logout(this.readCookie(request).token)
    response.clearCookie(this.cookieName, this.cookieOptions)
  }
}

