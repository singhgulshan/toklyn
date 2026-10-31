---
'toklyn': minor
'@toklyn/redis': minor
---

Sessions now have `lastRefreshedAt`: equal to `createdAt` at first, then updated by every successful refresh. In the default `offline` mode access tokens are verified without the store, so this is the last refresh, not the last request.

Add `auth.revokeOtherSessions(subject, keepSessionId)` for "sign out other devices".

`Session.lastRefreshedAt` is required, so custom `SessionStore` implementations must store it and set it in `rotate`; the contract suite checks this. `RedisSessionStore` reads sessions written by 0.1.0 with `lastRefreshedAt` equal to `createdAt`.
