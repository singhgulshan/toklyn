import { Module } from '@nestjs/common';
import type {
  DynamicModule,
  FactoryProvider,
  ModuleMetadata,
  Provider,
} from '@nestjs/common';
import type { AccessTokenVerifier, Auth, ClaimsShape } from 'toklyn';
import { createToklynHttp, createToklynResource } from 'toklyn/http';
import type { ToklynHttpOptions, ToklynResourceOptions } from 'toklyn/http';
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

export interface ToklynResourceModuleOptions extends ToklynResourceOptions {
  verifier: AccessTokenVerifier;
}

export interface ToklynResourceModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory: (
    ...args: never[]
  ) => ToklynResourceModuleOptions | Promise<ToklynResourceModuleOptions>;
}

/** Global module: register once in the root module. */
@Module({})
export class ToklynModule {
  static forRoot(options: ToklynModuleOptions): DynamicModule {
    return toklynModule(
      [{ provide: TOKLYN_HTTP, useValue: createHttp(options) }],
      [],
      true,
    );
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
      true,
    );
  }

  /**
   * For a service that only verifies tokens, e.g. with a `RemoteJwksAccessTokenVerifier`.
   * Provides `ToklynAuthGuard` (Bearer tokens only), not `ToklynSessionService`.
   */
  static forResource(options: ToklynResourceModuleOptions): DynamicModule {
    return toklynModule(
      [{ provide: TOKLYN_HTTP, useValue: createResource(options) }],
      [],
      false,
    );
  }

  static forResourceAsync(
    options: ToklynResourceModuleAsyncOptions,
  ): DynamicModule {
    const factory = options.useFactory as (
      ...args: unknown[]
    ) => ToklynResourceModuleOptions | Promise<ToklynResourceModuleOptions>;
    return toklynModule(
      [
        {
          provide: TOKLYN_HTTP,
          inject: options.inject ?? [],
          useFactory: async (...args: unknown[]) =>
            createResource(await factory(...args)),
        },
      ],
      options.imports,
      false,
    );
  }
}

function toklynModule(
  providers: Provider[],
  imports: ModuleMetadata['imports'] | undefined,
  sessions: boolean,
): DynamicModule {
  const shared = sessions
    ? [ToklynAuthGuard, ToklynSessionService]
    : [ToklynAuthGuard];
  return {
    module: ToklynModule,
    global: true,
    imports: imports ?? [],
    providers: [...providers, ...shared],
    exports: [TOKLYN_HTTP, ...shared],
  };
}

function createHttp({ auth, ...options }: ToklynModuleOptions) {
  return createToklynHttp(auth, options);
}

function createResource({ verifier, ...options }: ToklynResourceModuleOptions) {
  return createToklynResource(verifier, options);
}
