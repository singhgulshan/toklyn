---
'toklyn': minor
'@toklyn/store': minor
---

Security: `onRefresh` now runs only after the presented refresh token is found by its hash. Before, any token of the form `<session id>.<anything>` ran the hook, and a hook returning `null` revoked the session, so anyone who had seen an access token (which carries the session id) could trigger the hook and log the user out.

Breaking for custom stores: `SessionStore` has a new required read-only method, `findByToken(hash)`, which returns the token record with its session, or `null`. All built-in stores implement it, and `sessionStoreContract` covers it.
