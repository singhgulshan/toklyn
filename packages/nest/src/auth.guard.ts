import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import type { OptionalAuthOptions, ToklynAuthenticator } from 'toklyn/http';
import {
  TOKLYN_HTTP,
  TOKLYN_OPTIONAL,
  TOKLYN_PUBLIC,
  claimsByRequest,
  toHttpRequest,
  writeHeaders,
} from './internal.js';
import type { NodeStyleRequest } from './internal.js';

/**
 * Requires a valid access token. Use per route with `@UseGuards`, or app-wide as `APP_GUARD`
 * and opt routes out with `@ToklynPublic()` or let guests in with `@ToklynOptional()`.
 * Non-HTTP contexts are denied.
 */
@Injectable()
export class ToklynAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TOKLYN_HTTP) private readonly http: ToklynAuthenticator,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      TOKLYN_PUBLIC,
      targets,
    );
    if (isPublic === true) return true;
    if (context.getType() !== 'http') return false;
    const optional = this.reflector.getAllAndOverride<
      OptionalAuthOptions | undefined
    >(TOKLYN_OPTIONAL, targets);

    const http = context.switchToHttp();
    const req = http.getRequest<NodeStyleRequest>();
    const request = toHttpRequest(req);
    const result = optional
      ? await this.http.authenticateOptional(request, optional)
      : await this.http.authenticate(request);
    if (result.ok) {
      claimsByRequest.set(req, result.claims);
      return true;
    }

    const { response } = result;
    const res = http.getResponse<object>();
    writeHeaders(this.adapterHost.httpAdapter, res, response.headers);
    throw new HttpException(response.body ?? {}, response.status);
  }
}
