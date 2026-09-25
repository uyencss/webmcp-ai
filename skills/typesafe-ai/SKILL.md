---
name: typesafe-ai
description: Reference notes for the TypeSafe SystemOne HTTP transport interface as used by the WebMCP Jev decision runtime. Use when configuring or troubleshooting TypeSafe transport parameters including base URL requirements, mode-0600 key file validation, HTTPS enforcement, and timeout constraints.
---

# TypeSafe AI Transport Interface

Advisory notes for the TypeSafe SystemOne API HTTP transport used by the WebMCP Jev decision runtime (`packages/webmcp-ai-cli/src/jev/transport.mjs`). All behaviors described here are enforced in code; this document provides operator guidance only.

## Transport Constraints and Rules

Every claim corresponds directly to `packages/webmcp-ai-cli/src/jev/transport.mjs` and fails closed with `JEV_CONFIG_MISSING`:

- **API Key Handling (`readKeyFile`)**:
  - The API key is loaded strictly from a local filesystem file passed by path.
  - The key path must be a non-empty string; if missing or invalid, throws:
    `jev key file path must be a non-empty string`
  - The key file must exist and be readable; otherwise throws:
    `jev key file is not readable`
  - The file MUST be owner-only mode 0600 (no group/other bits, `(stat.mode & 0o077) !== 0`); otherwise throws:
    `jev key file must be owner-only (mode 0600)`
  - The file content cannot be empty after trimming; otherwise throws:
    `jev key file is empty`
  - The key is sent as `Authorization: Bearer <apiKey>` header. Transport creation requires an explicitly supplied key; otherwise throws:
    `typesafe transport requires an explicitly supplied apiKey (mode-0600 file content; vault broker is an M3 open item)`
  - `process.env` is never consulted for secrets, and keys are never accepted inline or in URL strings.

- **Base URL Rules (`assertSafeBaseUrl`, `assertKeyNotInBaseUrl`)**:
  - Requires an explicit baseUrl; otherwise throws:
    `typesafe transport requires an explicit baseUrl`
  - Must be an absolute URL; otherwise throws:
    `typesafe transport requires baseUrl to be an absolute URL`
  - Refuses userinfo, query string, or hash fragment; otherwise throws:
    `typesafe transport refuses a baseUrl carrying userinfo, query, or fragment`
  - Refuses malformed percent-encoding; otherwise throws:
    `typesafe transport refuses a baseUrl with malformed percent-encoding`
  - Refuses a URL carrying the API key anywhere (userinfo, query, or path, raw or percent-encoded); otherwise throws:
    `typesafe transport refuses a baseUrl containing the api key`
  - Refuses a URL carrying any registered secret; otherwise throws:
    `typesafe transport refuses a baseUrl containing a secret`

- **HTTPS and Loopback Policy**:
  - The transport enforces `https:` for all remote endpoints; cleartext HTTP is rejected:
    `typesafe transport refuses non-https baseUrl ${parsed.protocol}//${parsed.host}`
  - Non-HTTPS is allowed exclusively for exact loopback destinations: `localhost`, `[::1]`, or IPv4 loopback matching `/^127(\.\d{1,3}){3}$/`.

- **Timeout and Fetch Implementation**:
  - Requires `timeoutMs` to be an integer >= 1 (defaults to 10,000 ms); otherwise throws:
    `typesafe transport requires timeoutMs to be an integer >= 1`
  - Hard timeout aborts outbound requests via `AbortController`.
  - Requires a usable fetch implementation (`fetchFn` or `globalThis.fetch`); otherwise throws:
    `no fetch implementation is available for the typesafe transport`

## Operational Boundaries

This skill is strictly advisory reference documentation:
- **No authentication enrollment**: Does not perform login, account provisioning, or credential registration.
- **No key storage**: Does not store or persist API keys or credentials.
- **Enforcement location**: All validation, security assertions, and transport controls live exclusively in runtime code (`packages/webmcp-ai-cli/src/jev/`).
