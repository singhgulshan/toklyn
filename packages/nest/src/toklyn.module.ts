import { Module } from '@nestjs/common';
import type {
  DynamicModule,
  FactoryProvider,
  ModuleMetadata,
  Provider,
} from '@nestjs/common';
import type { Auth, ClaimsShape } from 'toklyn';
import { createToklynHttp } from 'toklyn/http';
import type { ToklynHttpOptions } from 'toklyn/http';
import { ToklynAuthGuard } from './auth.guard.js';
import { TOKLYN_HTTP } from './internal.js';
import { ToklynSessionService } from './session.service.js';

// Defaults to any claims type, so `Auth<YourClaims>` fits without a type argument.
export interface ToklynModuleOptions<
  TClaims extends ClaimsShape = ClaimsShape,
> extends ToklynHttpOptions {
  auth: Auth<TClaims>;
}

export interface ToklynModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory: (
    ...args: never[]
  ) => ToklynModuleOptions | Promise<ToklynModuleOptions>;
}

/** Global module: register once in the root module. */
@Module({})
export class ToklynModule {
  static forRoot(options: ToklynModuleOptions): DynamicModule {
    return toklynModule([
      { provide: TOKLYN_HTTP, useValue: createHttp(options) },
    ]);
  }

  static forRootAsync(options: ToklynModuleAsyncOptions): DynamicModule {
    const factory = options.useFactory as (
      ...args: unknown[]
    ) => ToklynModuleOptions | Promise<ToklynModuleOptions>;
    return toklynModule(
      [
        {
          provide: TOKLYN_HTTP,
          inject: options.inject ?? [],
          useFactory: async (...args: unknown[]) =>
            createHttp(await factory(...args)),
        },
      ],
      options.imports,
    );
  }
}

function toklynModule(
  providers: Provider[],
  imports: ModuleMetadata['imports'] = [],
): DynamicModule {
  return {
    module: ToklynModule,
    global: true,
    imports,
    providers: [...providers, ToklynAuthGuard, ToklynSessionService],
    exports: [TOKLYN_HTTP, ToklynAuthGuard, ToklynSessionService],
  };
}

function createHttp({ auth, ...options }: ToklynModuleOptions) {
  return createToklynHttp(auth, options);
}
