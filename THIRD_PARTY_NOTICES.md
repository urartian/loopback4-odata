# Third-Party Notices

This project is distributed under the [MIT License](./LICENSE).

## Audit scope

This notice summarizes the dependency license surface that was present in the
installed `node_modules` tree during the pre-v1 legal review on 2026-04-04.

The audit found 554 installed packages with no GPL, AGPL, or LGPL licenses in
the current tree. The installed package set was overwhelmingly permissive:

- `MIT`: 439 packages
- `ISC`: 48 packages
- `BSD-3-Clause`: 33 packages
- `Apache-2.0`: 12 packages
- `BSD-2-Clause`: 10 packages
- `BlueOak-1.0.0`: 6 packages
- `Artistic-2.0`: 2 packages
- `0BSD`: 1 package
- `Python-2.0`: 1 package
- `(MIT OR CC0-1.0)`: 1 package

The project's direct runtime and framework-facing dependencies are also all
under permissive licenses compatible with MIT distribution.

## Direct runtime dependencies

- `ipaddr.js` - MIT
- `inflection` - MIT
- `odata-v4-parser` - MIT
- `reflect-metadata` - Apache-2.0
- `tslib` - 0BSD

## Direct framework and database dependencies

- `@loopback/boot` - MIT
- `@loopback/core` - MIT
- `@loopback/repository` - MIT
- `@loopback/rest` - MIT
- `loopback-connector-postgresql` - Artistic-2.0

## Notes

- `reflect-metadata` is Apache-2.0, which is permissive and compatible with
  MIT-licensed distribution.
- `tslib` is 0BSD, which is permissive and compatible with MIT-licensed
  distribution.
- `loopback-connector-postgresql` is Artistic-2.0, which is a permissive
  license and acceptable for this package's current distribution model.

For future releases, update this file if the direct dependency set or the
license surface changes materially.
