# Contributing

## Dev setup

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
```

`build`'s `tsc` excludes `*.test.ts` (test files shouldn't end up in the published `dist/`), so it
never type-checks tests. `typecheck` runs the same compiler over the whole program, tests included,
via `tsconfig.test.json` (extends the base config, `noEmit`, no exclusion). `vitest run` itself
doesn't type-check — it transpiles with esbuild, which strips types without checking them — so
`typecheck` is the only step that catches a type error confined to a test file.

Node version is pinned in `.nvmrc`. This app uses `node:sqlite` (`DatabaseSync`), which requires
Node **≥ 22.5** — there is no native module to compile, so `pnpm install` needs no build toolchain.

## Local end-to-end

Testing against real Signal needs a linked signal-cli account (see the README's Prerequisites).
Once linked and with `SIGNAL_ACCOUNT` exported:

```bash
pnpm run build
node dist/cli/index.js daemon        # terminal 1: ingestion (leave running)
node dist/cli/index.js doctor        # terminal 2
node dist/cli/index.js conversations
```

Do **not** run automated tests against a real linked account.

## Commit messages

This repo releases via [semantic-release](https://semantic-release.gitbook.io/semantic-release/):
every commit message on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/),
because the release automation reads the commit history to decide what to publish. There is no
manual version bump — don't edit `version` in `package.json`.

| Prefix | Effect |
| --- | --- |
| `fix: ...` | patch release |
| `feat: ...` | minor release |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major release |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | no release |

Never spell out GitHub's own skip-CI marker (the bracketed "skip" + "ci" pair) literally in a
commit message unless you actually want that push to skip every workflow — GitHub matches it as a
plain substring anywhere in the message.

## Release process

Merging to `main` runs [`.github/workflows/release.yml`](./.github/workflows/release.yml), which
calls [myceliumhq/.github](https://github.com/myceliumhq/.github)'s reusable release workflow:
build, test, then `semantic-release` (config in `.releaserc.json`) computes the next version from
commits since the last release tag, publishes to npm, and creates a GitHub release with generated
notes. The Docker images (`sig-mcp`, `sig-semanticd`) publish from the `docker-*.yml` workflows once
the release tag lands.

Publishing uses npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no
token secret. `@myceliumhq/sig` on npmjs.com must have a Trusted Publisher configured pointing at
this exact repo and workflow filename (`myceliumhq/sig`, `.github/workflows/release.yml`). Both this
file's job and the shared workflow must grant `permissions: id-token: write`. A brand-new package's
first npm publish is a manual, one-time bootstrap step — don't try to "fix" a failing first release
by adding more workflow logic.
