# Security policy

toklyn handles authentication, so security reports are treated as the highest priority.

## Supported versions

Only the latest published version receives security fixes. All packages (`toklyn`, `@toklyn/*`) share one version number.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a vulnerability.**

Report it privately through GitHub: go to the [Security tab](https://github.com/singhgulshan/toklyn/security) and click **Report a vulnerability**.

Please include:

- the affected package(s) and version
- a description of the issue and its impact
- steps or a minimal script to reproduce it
- any suggested fix, if you have one

## What to expect

- Acknowledgement within 3 days.
- An initial assessment within 7 days.
- A fix released as soon as possible, followed by a published GitHub Security Advisory crediting you (unless you prefer to stay anonymous).

Please give us a reasonable chance to release a fix before disclosing the issue publicly.

## Scope

In scope: token issuing and verification, refresh token rotation and reuse detection, session and revocation stores, cookie and CSRF handling, JWKS, and the framework adapters.

Out of scope: vulnerabilities in your own login logic, misconfiguration (for example weak secrets or disabled `secure` cookies), and issues in the `examples/` folder that do not affect the published packages.
