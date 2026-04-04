# Maintainer Guidelines

This document defines the minimum expectations for maintainers of
`@loopback/odata`.

## Core responsibilities

Maintainers are expected to:

- protect the public API and supported configuration contract
- review pull requests for correctness, regressions, and release impact
- keep documentation aligned with the supported feature set
- triage issues and label bug reports, enhancements, and questions
- keep dependency and security reviews moving forward

## Review expectations

Before merging a substantial change, confirm:

- tests and lint pass
- public exports in `src/index.ts` are intentional
- TypeDoc output still reflects the intended API surface
- release-impacting changes are documented in `docs/pre-v1-notes.md` or release notes

## Release expectations

Before tagging a release, maintainers should:

- review `V1_RELEASE_PREPARATION.md` or the active release checklist
- confirm CI status on the supported runtime baseline
- verify docs, TypeDoc, and compatibility notes are current
- review dependency and security status

## Communication expectations

Maintainers should:

- be respectful and clear in reviews
- explain why changes are requested when blocking a PR
- prefer narrowing scope over accepting unclear release risk
- redirect feature requests that are out of current scope into roadmap discussion
