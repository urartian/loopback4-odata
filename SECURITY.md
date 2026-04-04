# Security Policy

## Reporting a vulnerability

If you believe you have found a security issue in `@urartian/loopback4-odata`, please do
not open a public GitHub issue with exploit details first.

Instead:

- contact the maintainers privately through the repository security reporting
  channel if available
- or open a minimal private disclosure with reproduction details, affected
  versions, and impact assessment

Please include:

- affected package version
- Node.js version
- deployment shape or connector details if relevant
- reproduction steps or proof of concept
- impact summary

## Response expectations

The project aims to:

- acknowledge reports promptly
- validate the issue and assess severity
- prepare a fix or mitigation when appropriate
- coordinate public disclosure after a fix is available or a mitigation is documented

## Scope

Security reports should focus on:

- the package runtime
- the documented supported configuration surface
- supported PostgreSQL deployment behavior

Reports that only affect local development tooling or unsupported experimental
paths may be triaged at a lower priority.
