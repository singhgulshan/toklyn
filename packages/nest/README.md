# @toklyn/nest

**NestJS module, guard and decorators for [toklyn](https://github.com/singhgulshan/toklyn) sessions.**

[![npm](https://img.shields.io/npm/v/@toklyn/nest?color=cb3837&logo=npm)](https://www.npmjs.com/package/@toklyn/nest)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)

## Install

```sh
npm install toklyn @toklyn/nest
```

Supports NestJS 9 or later, on the Express and Fastify platforms. The package itself does not rely on `emitDecoratorMetadata`.

## Usage

Register the module once and protect every route by default:

```ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ToklynAuthGuard, ToklynModule } from '@toklyn/nest';
import { auth } from './auth.js';

// your createAuth(...) instance

@Module({
  imports: [ToklynModule.forRoot({ auth })],
  controllers: [AuthController],
  providers: [{ provide: APP_GUARD, useClass: ToklynAuthGuard }],
})
export class AppModule {}
```

Login, refresh and logout write the response themselves, so they take `@Res()`:

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ToklynClaims, ToklynPublic, ToklynSessionService } from '@toklyn/nest';
import type { NodeStyleRequest } from '@toklyn/nest';
import type { Response } from 'express';
import type { AccessTokenClaims } from 'toklyn';
import { type AppClaims, auth } from './auth.js';
import { UsersService } from './users.service.js';

@Controller('api')
export class AuthController {
  constructor(
    private readonly sessions: ToklynSessionService,
    private readonly users: UsersService,
  ) {}

  @ToklynPublic()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { email: string; password: string },
    @Res() res: Response,
  ) {
    const user = await this.users.checkPassword(body); // your credential check
    if (!user) throw new UnauthorizedException();
    this.sessions.sendSession(
      res,
      await auth.createSession({ subject: user.id }),
    );
  }

  // Refresh and logout authenticate with the refresh cookie, not a Bearer token.
  @ToklynPublic()
  @Post('refresh')
  refresh(@Req() req: NodeStyleRequest, @Res() res: Response) {
    return this.sessions.refresh(req, res);
  }

  @ToklynPublic()
  @Post('logout')
  logout(@Req() req: NodeStyleRequest, @Res() res: Response) {
    return this.sessions.logout(req, res);
  }

  @Get('me')
  me(@ToklynClaims() claims: AccessTokenClaims<AppClaims>) {
    return { id: claims.sub, role: claims.role };
  }
}
```

Use `ToklynModule.forRootAsync({ imports, inject, useFactory })` when `auth` comes from another provider; see the [example module](https://github.com/singhgulshan/toklyn/blob/main/examples/nest/src/app.module.ts).

## API

| Export                                                         | Description                                                                                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToklynModule.forRoot({ auth, ...httpOptions })`               | Global module. `httpOptions` are the [HTTP options](https://github.com/singhgulshan/toklyn#http-options) of `toklyn/http`                           |
| `ToklynModule.forRootAsync({ imports?, inject?, useFactory })` | Same, with options from a factory                                                                                                                   |
| `ToklynAuthGuard`                                              | Requires a valid access token. Use with `@UseGuards()` or as `APP_GUARD`. Non-HTTP contexts are denied                                              |
| `@ToklynPublic()`                                              | Skips the guard for a route or controller                                                                                                           |
| `@ToklynOptional(options?)`                                    | Lets guests through the guard. `{ invalidToken: 'ignore' }` also treats invalid tokens as guests; the default answers `401`. `@ToklynPublic()` wins |
| `@ToklynClaims()`                                              | Injects the verified claims, or `null` for a guest on a `@ToklynOptional()` route. Throws if the guard did not run                                  |
| `ToklynSessionService`                                         | `sendSession(res, tokens)`, `refresh(req, res)`, `logout(req, res)`                                                                                 |

## Links

- [Full documentation](https://github.com/singhgulshan/toklyn#readme)
- [Runnable example](https://github.com/singhgulshan/toklyn/tree/main/examples/nest)
- [Security model](https://github.com/singhgulshan/toklyn#security-model)

## License

[MIT](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)
