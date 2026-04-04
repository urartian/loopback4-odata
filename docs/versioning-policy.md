# Versioning Policy

`@loopback/odata` follows semantic versioning for published releases.

## Versioning rules

- **Patch** releases fix bugs, tighten docs, improve tests, or make internal
  changes without changing the supported public contract
- **Minor** releases add backward-compatible features or new opt-in
  configuration
- **Major** releases may remove supported APIs, change defaults in incompatible
  ways, or otherwise require user action

## Breaking changes

Treat these as breaking unless clearly documented otherwise:

- removing or renaming exports from `src/index.ts`
- removing supported decorators, config fields, or documented behavior
- changing default runtime behavior in a way that affects existing applications
- dropping supported Node, LoopBack, or PostgreSQL contract boundaries

## Changelog format

Release notes and changelogs should follow a Keep a Changelog style with clear
sections such as:

- `Added`
- `Changed`
- `Fixed`
- `Deprecated`
- `Removed`
- `Security`

## Communication expectations

When a release contains a breaking or contract-affecting change:

- document it clearly in release notes
- update [docs/pre-v1-notes.md](/workspace/docs/pre-v1-notes.md) when the
  supported contract changes
- update narrative docs and TypeDoc when public behavior changes
