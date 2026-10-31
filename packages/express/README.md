# @toklyn/express

**Express middleware and route handlers for [toklyn](https://github.com/singhgulshan/toklyn) sessions.**

[![npm](https://img.shields.io/npm/v/@toklyn/express?color=cb3837&logo=npm)](https://www.npmjs.com/package/@toklyn/express)
[![CI](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml/badge.svg)](https://github.com/singhgulshan/toklyn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)

## Install

```sh
npm install toklyn @toklyn/express
```

Requires Express 5, which forwards errors from async handlers.

## Usage

```ts
import { createToklynExpress, getAuth } from '@toklyn/express';
import express from 'express';
import { auth } from './auth.js';

// your createAuth(...) instance

const toklyn = createToklynExpress(auth);
const app = express();
app.use(express.json());

app.post('/api/login', async (req, res) => {
  const user = await checkPassword(req.body); // your credential check
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const tokens = await auth.createSession({
    subject: user.id,
    claims: { role: user.role },
  });
  toklyn.sendSession(res, tokens);
});

app.post('/api/refresh', toklyn.refreshHandler);
app.post('/api/logout', toklyn.logoutHandler);

app.get('/api/me', toklyn.requireAuth, (req, res) => {
  const claims = getAuth<AppClaims>(req);
  res.json({ id: claims.sub, role: claims.role });
});
```

The login response contains the access token in its JSON body and sets the refresh token as an `HttpOnly` cookie. The browser client keeps the access token in memory, sends it as `Authorization: Bearer`, and calls `/api/refresh` on page load and after a `401`. See the [client in the example](https://github.com/singhgulshan/toklyn/blob/main/examples/express/public/app.js).

## API

### `createToklynExpress(auth, options?)`

`options` are the [HTTP options](https://github.com/singhgulshan/toklyn#http-options) of `toklyn/http` (`accessToken`, `cookie`, `accessCookie`, `allowedOrigins`, `clock`). Returns:

| Member                     | Description                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `requireAuth`              | Middleware. Responds `401` unless the request has a valid access token                                                            |
| `optionalAuth(options?)`   | Middleware that lets guests through. `{ invalidToken: 'ignore' }` also treats invalid tokens as guests; the default answers `401` |
| `refreshHandler`           | Mount on `POST`. Rotates the refresh cookie and returns a new access token                                                        |
| `logoutHandler`            | Mount on `POST`. Revokes the session and clears the cookie; responds `204`                                                        |
| `sendSession(res, tokens)` | Sends the login response after `auth.createSession`                                                                               |

### `getAuth<TClaims>(req)`

Returns the verified claims of the current request. Throws if `requireAuth` did not run on the route, or if the request is a guest.

### `getOptionalAuth<TClaims>(req)`

Returns the claims, or `null` for a guest. Throws if neither `optionalAuth` nor `requireAuth` ran on the route.

## Links

- [Full documentation](https://github.com/singhgulshan/toklyn#readme)
- [Runnable example](https://github.com/singhgulshan/toklyn/tree/main/examples/express)
- [Security model](https://github.com/singhgulshan/toklyn#security-model)

## License

[MIT](https://github.com/singhgulshan/toklyn/blob/main/LICENSE)
