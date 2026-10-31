import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ToklynClaims, ToklynPublic, ToklynSessionService } from '@toklyn/nest';
import type { NodeStyleRequest } from '@toklyn/nest';
import type { Response } from 'express';
import type { AccessTokenClaims, Auth } from 'toklyn';
import { AUTH, findUser } from './auth.js';
import type { AppClaims } from './auth.js';

@Controller('api')
export class AuthController {
  constructor(
    private readonly sessions: ToklynSessionService,
    @Inject(AUTH) private readonly auth: Auth<AppClaims>,
  ) {}

  @ToklynPublic()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { username?: unknown; password?: unknown } | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const user = findUser(body?.username, body?.password);
    if (!user) throw new UnauthorizedException();
    const tokens = await this.auth.createSession({
      subject: user.id,
      claims: { role: user.role },
    });
    this.sessions.sendSession(res, tokens);
  }

  // Refresh and logout authenticate with the refresh cookie, not a Bearer token.
  @ToklynPublic()
  @Post('refresh')
  refresh(@Req() req: NodeStyleRequest, @Res() res: Response): Promise<void> {
    return this.sessions.refresh(req, res);
  }

  @ToklynPublic()
  @Post('logout')
  logout(@Req() req: NodeStyleRequest, @Res() res: Response): Promise<void> {
    return this.sessions.logout(req, res);
  }

  @Get('me')
  me(@ToklynClaims() claims: AccessTokenClaims<AppClaims>) {
    const { sub, sid, role, exp } = claims;
    return { sub, sid, role, exp };
  }
}
