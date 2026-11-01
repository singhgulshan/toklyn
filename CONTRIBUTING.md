# Contributing to toklyn

Thanks for helping. Bug reports, fixes, docs and new stores or adapters are all welcome.

For security issues, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Before you start

For anything bigger than a small fix, open an issue first so we can agree on the approach.

## Setup

Requirements: Node.js 22.12 or later (see `.nvmrc`) and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```sh
git clone https://github.com/singhgulshan/toklyn.git
cd toklyn
pnpm install
pnpm build
```

## Repository layout

| Path               | Package                                    |
| ------------------ | ------------------------------------------ |
| `packages/core`    | `toklyn`                                   |
| `packages/express` | `@toklyn/express`                          |
| `packages/fastify` | `@toklyn/fastify`                          |
| `packages/nest`    | `@toklyn/nest`                             |
| `packages/next`    | `@toklyn/next`                             |
| `packages/store`   | `@toklyn/store`                            |
| `examples/*`       | runnable examples (private, not published) |

## Checks

Run these before opening a pull request. CI runs the same ones.

```sh
pnpm format:check   # or pnpm format to fix
pnpm lint
pnpm build
pnpm typecheck
pnpm test
pnpm test:edge
pnpm check:exports
```

To run one package only: `pnpm --filter toklyn test`.

### Database tests

Without any URLs, Postgres tests run against in-process PGlite, SQLite in memory, and MySQL/MariaDB and MongoDB server suites are skipped. Redis tests need a server, defaulting to `redis://localhost:6379`. Set the URLs to run against real servers:

```sh
POSTGRES_URL=postgres://... \
MYSQL_URL=mysql://... \
MARIADB_URL=mysql://... \
MONGODB_URL=mongodb://... \
REDIS_URL=redis://... \
pnpm --filter @toklyn/store test
```

If you change a store, run the matching examples too: `pnpm --filter "./examples/with-*" run check`.

## Pull requests

- Keep each pull request focused on one change.
- Add or update tests for every behaviour change. Security-relevant paths (rotation, reuse detection, revocation, cookies, CSRF) need tests for the failure cases as well.
- Update the README of the affected package when the public API changes.
- Add a changeset for any change to a published package:

  ```sh
  pnpm changeset
  ```

  Pick the bump: `patch` for fixes, `minor` for new features. While toklyn is below 1.0, breaking changes are also `minor`; say so clearly in the changeset text. Changes that only touch examples, tests or CI do not need a changeset.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
