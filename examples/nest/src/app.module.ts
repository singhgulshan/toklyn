import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ToklynAuthGuard, ToklynModule } from '@toklyn/nest';
import type { Auth } from 'toklyn';
import { AuthController } from './auth.controller.js';
import { AUTH, createAppAuth } from './auth.js';
import type { AppClaims } from './auth.js';

@Module({
  providers: [{ provide: AUTH, useFactory: createAppAuth }],
  exports: [AUTH],
})
class AuthModule {}

@Module({
  imports: [
    AuthModule,
    ToklynModule.forRootAsync({
      imports: [AuthModule],
      inject: [AUTH],
      useFactory: (auth: Auth<AppClaims>) => ({ auth }),
    }),
  ],
  controllers: [AuthController],
  // Every route needs a Bearer token unless marked @ToklynPublic().
  providers: [{ provide: APP_GUARD, useClass: ToklynAuthGuard }],
})
export class AppModule {}
