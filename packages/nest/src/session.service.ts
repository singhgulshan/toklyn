import { Inject, Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { TokenPair } from 'toklyn';
import type { ToklynHttp, ToklynHttpResponse } from 'toklyn/http';
import { TOKLYN_HTTP, toHttpRequest } from './internal.js';
import type { NodeStyleRequest } from './internal.js';

/**
 * Writes session responses from your own controller. Inject the platform objects with
 * `@Req()` and `@Res()`, and mark refresh and logout routes `@ToklynPublic()` when the
 * guard is global: they authenticate with the refresh cookie, not a Bearer token.
 */
@Injectable()
export class ToklynSessionService {
  constructor(
    @Inject(TOKLYN_HTTP) private readonly http: ToklynHttp,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {}

  /** Login response, after `auth.createSession`. */
  sendSession(res: object, tokens: TokenPair): void {
    this.send(res, this.http.issue(tokens));
  }

  /** Rotates the refresh cookie and returns a new access token. */
  async refresh(req: NodeStyleRequest, res: object): Promise<void> {
    this.send(res, await this.http.refresh(toHttpRequest(req)));
  }

  /** Revokes the cookie's session and clears the cookie. */
  async logout(req: NodeStyleRequest, res: object): Promise<void> {
    this.send(res, await this.http.logout(toHttpRequest(req)));
  }

  private send(res: object, response: ToklynHttpResponse): void {
    const adapter = this.adapterHost.httpAdapter;
    for (const [name, value] of response.headers) {
      adapter.setHeader(res, name, value);
    }
    adapter.reply(res, response.body ?? undefined, response.status);
  }
}
