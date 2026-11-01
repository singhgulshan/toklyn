---
'toklyn': minor
---

Add `accessTokensFromEnv()` (HS256 from `TOKLYN_SECRET`, with `TOKLYN_SECRET_PREVIOUS` for rotation, `TOKLYN_ISSUER` and `TOKLYN_AUDIENCE`), `httpOptionsFromEnv()` in `toklyn/http` (`TOKLYN_ALLOWED_ORIGINS`, `TOKLYN_COOKIE_DOMAIN`), and `toklyn/test-utils` with `createTestAuth` and `createTestClock` for any test runner. Passing keys in code works as before.
