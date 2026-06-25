# Shepherd Implementation Foundation and Quality Gates

Date: 2026-06-24

Parent: [Shepherd Herdr Orchestration Plan](../2026-06-24-shepherd-herdr-orchestration.md)

## Status

Archived. Foundation and quality gates are complete.

## Progress

- **Done** — TypeScript, Vitest, Biome, Drizzle, SQLite, TypeBox/Ajv, Husky, and mise setup were implemented.
- **Done** — `pnpm check` and `pnpm build` expectations were established.

## Next steps

- Continue using the established gates for all implementation work.

## Goal

Define the implementation foundation, test strategy, linting, formatting, and pre-commit gates before MVP code starts.

## Implementation status

Status as of 2026-06-24 latest `main`: complete.

Implemented:

- `mise.toml` pins Node.js `24.18.0` and pnpm `11.9.0`.
- single private TypeScript package with ESM and `NodeNext`.
- strict TypeScript config, build config, and `@/*` imports for `src/*`.
- Vitest unit/integration tests with external systems faked in tests.
- Biome lint/format/import organization gate excluding Markdown docs.
- Husky pre-commit hook with lint-staged staged-file Biome fixes plus full typecheck, test, lint, format, and Drizzle check.
- SQLite via `node:sqlite`, Drizzle schema, committed migrations, and migration consistency check.
- TypeBox/Ajv for config and logical tool runtime schemas.
- non-placeholder tests across naming, JSON Lines, config, DB, daemon, delivery, Slack, gateway, and Herdr adapters.

## Runtime and package management

Shepherd starts as a single TypeScript package.

- Use TypeScript on Node.js.
- Use Node.js latest LTS through `mise`.
- Use pnpm latest stable through `mise`.
- Do not start with a pnpm workspace or monorepo layout.
- Use ESM with `NodeNext`.
- Production and normal CLI execution should use built JavaScript from `dist`.
- Development commands may use a TypeScript runner such as `tsx`.

Initial layout:

```text
src/
  cli/
  config/
  daemon/
  db/
  gateway/
  herdr/
  messaging/
  tui/
test/
  unit/
  integration/
drizzle/
```

The directory names are initial ownership boundaries, not separate packages.

## Test strategy

Use Vitest.

Initial tests should use two layers:

- unit and contract tests for pure logic
- integration tests for SQLite, daemon transport, and event replay behavior

The first implementation scaffold should include at least one real utility and test rather than a placeholder test. Good first targets:

- Herdr/Shepherd name slug validation
- newline-delimited JSON-RPC/JSON Lines framing
- config schema validation

External systems should be faked in tests until the corresponding adapter is implemented:

- Herdr socket API
- Slack Socket Mode and Web API
- gateway LLM providers
- Codex app-server callback

Vitest must not pass with zero tests.

## Database foundation

Use SQLite with Drizzle.

- Use Node's built-in `node:sqlite` driver.
- Use Drizzle for TypeScript schema and typed query support.
- Generate SQL migrations and commit them.
- Review generated SQL migrations as part of normal code review.
- Allow raw SQL where it makes event-store, recovery, queueing, or idempotency behavior clearer than query builder code.

Drizzle is used as a typed SQL/schema layer, not as a reason to hide important recovery or idempotency behavior.

The initial DB tests should use temporary or in-memory SQLite databases and exercise real migrations when practical.

## Runtime schemas

Use TypeBox plus Ajv for runtime validation.

TypeBox/Ajv is the schema source for:

- YAML config validation
- logical tool input schemas
- provider-independent tool registry schemas
- JSON-RPC request and notification payloads
- platform adapter normalized event payloads where useful

Rationale:

- Shepherd logical tools are exposed to gateway providers as JSON Schema.
- The same schema source should validate runtime input and provide provider-facing tool schemas.
- JSON Schema should be treated as a first-class contract, not as an export artifact from another schema system.

DB schema remains owned by Drizzle. Runtime input and tool schemas remain owned by TypeBox/Ajv.

## Linting and formatting

Use Biome for linting, formatting, and import organization.

Biome scope:

- `src/**/*.ts`
- `test/**/*.ts`
- root TypeScript config files
- root JSON/JSONC config files

Markdown docs are not part of the Biome gate for MVP. Plan docs should avoid formatter churn unless a dedicated docs linting decision is made later.

Use a balanced Biome rule profile:

- recommended rules enabled
- formatter enabled
- organize imports enabled
- `noExplicitAny` as warning
- `noNonNullAssertion` as warning

The TypeScript compiler and schema validators should enforce important contracts. Biome warnings should make type holes visible without blocking early adapter work.

## Type checking and build

Use strict TypeScript.

Required compiler posture:

- `strict: true`
- `noEmit` for typecheck
- separate build command emitting to `dist`
- `module` and `moduleResolution` set for Node ESM

Pre-commit should run type checking. Build can be a separate command unless CI or release workflow later needs it in the same gate.

## Husky and lint-staged

Use Husky for Git hooks.

Use lint-staged as an automatic staged-file fixer, not as the only quality gate.

Pre-commit flow:

1. Run `pnpm lint-staged` to apply Biome fixes to staged code/config files.
2. Run full TypeScript typecheck.
3. Run full Vitest test suite.
4. Run full Biome check.
5. Run Drizzle migration/schema consistency check.

This is intentionally stricter than a staged-only hook. Shepherd has cross-module contracts where staged-only checks can miss breakage.

## Scripts

Initial package scripts should include:

- `typecheck`
- `test`
- `test:watch`
- `lint`
- `lint:fix`
- `format`
- `format:check`
- `db:generate`
- `db:migrate`
- `db:check`
- `check`
- `prepare`

`check` should represent the full local quality gate used by contributors and pre-commit.

## Implementation notes

The first foundation commit should add:

- `mise.toml`
- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `tsconfig.build.json` if needed
- `vitest.config.ts`
- `biome.json`
- `drizzle.config.ts`
- `.husky/pre-commit`
- initial `src` and `test` scaffold with a real tested utility

Do not introduce Slack, Herdr, or gateway provider SDKs in the foundation commit unless a first test or scaffold needs them.
