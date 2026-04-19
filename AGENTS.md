# AGENTS.md

## Toolchain
- Use `npm` only. The repo is a single-package project with `package-lock.json`; CI uses `npm ci`.
- Supported baseline is Node `22.x`. CI also runs an experimental job on Node `24.x`.

## Canonical Commands
- Install: `npm ci`
- Dev server: `npm run dev` (runs `examples/basic-app/index.ts` on `127.0.0.1:3001`)
- Build library: `npm run build`
- Lint: `npm run lint`
- Test all: `npm test`
- Unit only: `npm run test:unit`
- Acceptance only: `npm run test:acceptance`
- Coverage: `npm run test:coverage`
- TypeDoc API docs: `npm run docs:api`

## Verification Order
- Match CI for normal changes: `npm run lint` -> `npm run build` -> `npm test`
- If you change the public export surface in `src/index.ts`, also run `npm run docs:api`.

## Architecture
- Package entrypoint and public API surface: `src/index.ts`. Treat export changes there as contract changes.
- Component wiring lives in `src/component.ts`; it binds default config, middleware, providers, observers, and built-in controllers.
- Route generation/discovery lives in `src/booters/odata.booter.ts`; it inspects `@odataController` classes plus repository bindings and registers generated CRUD/singleton routes.
- `examples/basic-app/` is the real host app used for local dev, migrations, and many integration-style flows.

## Tests
- Tests are authored in `src/__tests__/` and compiled to `dist-tests/` before Mocha runs.
- Unit tests use `*.spec.ts`; acceptance tests use `*.acceptance.ts`. Keep the suffix correct or the split scripts will miss the file.
- There is no dedicated single-file test script. For a focused run, compile first with `tsc -p tsconfig.test.json`, then run Mocha against the compiled file under `dist-tests/src/__tests__/...`.

## Generated And Derived Output
- Do not edit `dist/`, `dist-tests/`, `coverage/`, or `docs/api/` by hand; regenerate them from source commands.
- `prepare` and `prepack` both run the build, so packaging/publish flows expect `dist/` to come from `npm run build`.

## Runtime And Data Quirks
- Production boot requires `ODATA_TOKEN_SECRET`; non-production auto-generates a per-boot secret in `src/component.ts`, which invalidates existing paging/delta tokens after restart.
- The documented/supported SQL path is PostgreSQL-first. MySQL code exists for internal experimentation and should not be treated as v1-supported behavior.
- `npm run migrate` targets the example app only: `examples/basic-app/migrations/migrate.ts`.

## Benchmarks
- Benchmark commands use `ts-node` with `tsconfig.bench.json`; start with `npm run bench:smoke` when iterating.
- Postgres benchmark commands are manual and can be destructive to the configured benchmark DB because the harness runs `automigrate()` before seeding. Use a disposable database.
