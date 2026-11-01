---
'toklyn': patch
---

`httpOptionsFromEnv()` now types the options it adds (`allowedOrigins`, `cookie`, `accessCookie`), so `httpOptionsFromEnv({ accessToken: 'bearer' }).allowedOrigins` type-checks.
