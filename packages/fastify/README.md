# @toklyn/fastify

**Fastify hooks and route handlers for [toklyn](https://github.com/singhgulshan/toklyn) sessions.**

[![npm](https://img.shields.io/npm/v/@toklyn/fastify?color=cb3837&logo=npm)](https://www.npmjs.com/package/@toklyn/fastify)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)

## Install

```sh
npm install toklyn @toklyn/fastify
```

Requires Fastify 5.

## Usage

```ts
import { createToklynFastify, getAuth } from '@toklyn/fastify';
import Fastify from 'fastify';
import { auth } from './auth.js';

// your createAuth(...) instance

const toklyn = createToklynFastify(auth);
const app = Fastify();

app.post('/api/login', async (request, reply) => {
  const user = await checkPassword(request.body); // your credential check
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  const tokens = await auth.createSession({
    subject: user.id,
    claims: { role: user.role },
  });
  return toklyn.sendSession(reply, tokens);
});

app.post('/api/refresh', toklyn.refreshHandler);
app.post('/api/logout', toklyn.logoutHandler);

app.get('/api/me', { preHandler: toklyn.requireAuth }, async (request) => {
  const claims = getAuth<AppClaims>(request);
  return { id: claims.sub, role: claims.role };
});
```

To protect every route in a scope, register the hook once: `app.addHook('preHandler', toklyn.requireAuth)` inside a plugin.

The login response contains the access token in its JSON body and sets the refresh token as an `HttpOnly` cookie. The browser client keeps the access token in memory, sends it as `Authorization: Bearer`, and calls `/api/refresh` on page load and after a `401`. See the [client in the Express example](https://github.com/singhgulshan/toklyn/blob/main/examples/express/public/app.js); it works unchanged.

## API

### `createToklynFastify(auth, options?)`

`options` are the [HTTP options](https://github.com/singhgulshan/toklyn#http-options) of `toklyn/http` (`accessToken`, `cookie`, `accessCookie`, `allowedOrigins`, `clock`). Returns:

| Member                       | Description                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `requireAuth`                | `preHandler` hook. Responds `401` unless the request has a valid access token                                                            |
| `optionalAuth(options?)`     | `preHandler` hook that lets guests through. `{ invalidToken: 'ignore' }` also treats invalid tokens as guests; the default answers `401` |
| `refreshHandler`             | Route handler for `POST`. Rotates the refresh cookie and returns a new access token                                                      |
| `logoutHandler`              | Route handler for `POST`. Revokes the session and clears the cookie; responds `204`                                                      |
| `sendSession(reply, tokens)` | Sends the login response after `auth.createSession`; return its result from your handler                                                 |

### `getAuth<TClaims>(request)`

Returns the verified claims of the current request. Throws if `requireAuth` did not run on the route, or if the request is a guest.

### `getOptionalAuth<TClaims>(request)`

Returns the claims, or `null` for a guest. Throws if neither `optionalAuth` nor `requireAuth` ran on the route.

### `jwksHandler(jwks)`

Route handler for `GET /.well-known/jwks.json` that publishes the set from `createJwks`. See [Publishing keys](https://github.com/singhgulshan/toklyn#publishing-keys-jwks).

### `createToklynFastifyResource(verifier, options?)`

For services that only verify tokens, for example with a `RemoteJwksAccessTokenVerifier`. Returns `requireAuth` and `optionalAuth(options?)` for Bearer tokens; `getAuth` and `getOptionalAuth` work as usual. `options.clock` sets the time tokens are checked against.

```ts
const api = createToklynFastifyResource(
  new RemoteJwksAccessTokenVerifier({
    url: 'https://auth.example.com/.well-known/jwks.json',
    algorithms: ['ES256'],
  }),
);
app.get('/api/me', { preHandler: api.requireAuth }, async (request) =>
  getAuth(request),
);
```

## Links

- [Full documentation](https://github.com/singhgulshan/toklyn#readme)
- [Security model](https://github.com/singhgulshan/toklyn#security-model)

## License

[MIT](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)
