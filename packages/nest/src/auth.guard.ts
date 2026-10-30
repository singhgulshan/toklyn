import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';
import type { ToklynHttp } from 'toklyn/http';
import {
  TOKLYN_HTTP,
  TOKLYN_PUBLIC,
  claimsByRequest,
  toHttpRequest,
} from './internal.js';
import type { NodeStyleRequest } from './internal.js';

/**
 * Requires a valid Bearer token. Use per route with `@UseGuards`, or app-wide as `APP_GUARD`
 * and opt routes out with `@ToklynPublic()`. Non-HTTP contexts are denied.
 */
@Injectable()
export class ToklynAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TOKLYN_HTTP) private readonly http: ToklynHttp,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      TOKLYN_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic === true) return true;
    if (context.getType() !== 'http') return false;

    const http = context.switchToHttp();
    const req = http.getRequest<NodeStyleRequest>();
    const result = await this.http.authenticate(toHttpRequest(req));
    if (result.ok) {
      claimsByRequest.set(req, result.claims);
      return true;
    }

    const { response } = result;
    const res = http.getResponse<object>();
    for (const [name, value] of response.headers) {
      this.adapterHost.httpAdapter.setHeader(res, name, value);
    }
    throw new HttpException(response.body ?? {}, response.status);
  }
}
