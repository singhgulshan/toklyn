---
'toklyn': minor
---

Add `onRefresh` to `createAuth`: runs before each refresh of an active session and can keep, replace (stored atomically with the rotation) or reject (revokes the session) its claims. If it throws, nothing is consumed and the refresh fails with `storage_error`.

Add `auth.logout(refreshToken)`, which revokes the token's session without signing new tokens or emitting `token_refreshed`. The HTTP `logout` flow now uses it.

Refresh tokens now start with their session id (`<sessionId>.<random>`); the whole string is hashed. Tokens issued by 0.1.0 keep working.

`AuthConfig` is now generic (`AuthConfig<TClaims>`). A config typed as plain `AuthConfig` passed to `createAuth<MyClaims>()` needs `AuthConfig<MyClaims>`.
