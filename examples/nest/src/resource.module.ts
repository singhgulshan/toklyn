import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ToklynAuthGuard, ToklynClaims, ToklynModule } from '@toklyn/nest';
import { RemoteJwksAccessTokenVerifier } from 'toklyn';
import type { AccessTokenClaims } from 'toklyn';
import type { AppClaims } from './auth.js';

@Controller('api')
class OrdersController {
  @Get('orders')
  orders(@ToklynClaims() claims: AccessTokenClaims<AppClaims>) {
    return { owner: claims.sub, role: claims.role, orders: [] };
  }
}

/**
 * A service that only verifies tokens: no secret and no session store, only the JWKS URL of
 * the service that signs them (for example `examples/jwks-resource-server`).
 */
@Module({
  imports: [
    ToklynModule.forResource({
      verifier: new RemoteJwksAccessTokenVerifier({
        url:
          process.env.JWKS_URL ?? 'http://localhost:4000/.well-known/jwks.json',
        algorithms: ['ES256'],
      }),
    }),
  ],
  controllers: [OrdersController],
  providers: [{ provide: APP_GUARD, useClass: ToklynAuthGuard }],
})
export class ResourceModule {}
