# Release Process

This document describes the lightweight release process for `@loopback/odata`.

## Before a release candidate

- review the active release checklist
- run `npm run lint`
- run `npm test`
- run `npm run docs:api` if the public API changed
- review `docs/pre-v1-notes.md` and compatibility docs for contract changes

## Release review

Before publishing:

- confirm the package version and changelog/release notes are correct
- review `src/index.ts` for intentional export-surface changes
- review TypeDoc output for unexpected public symbols
- confirm supported Node and LoopBack versions are still accurate
- confirm dependency/security review is up to date

## Publish flow

Suggested flow:

1. Merge the intended release branch or release commit.
2. Update versioning and release notes.
3. Rebuild and rerun final verification commands.
4. Publish the package.
5. Publish release notes and link relevant docs.

## After release

- monitor issues for regressions
- document hotfix-worthy problems quickly
- update roadmap and contract notes when priorities change
