# Identity and credentials

`GET /v1/register?payload=<JSON percent-encoded once>` and `POST /v1/register`
with `application/json` accept the same strict `{name?: string}` object.
Success is 201 `{id,name,api_key}`, private/no-store. No credentials are required.
Requested names preserve casing, are 1–39 ASCII letters/digits/single hyphens,
start/end alphanumerically and are unique case-insensitively. Conflict is 409;
invalid names are 400 with limit 39. Omitted names draw 3–5 words independently
from the pinned, attributed curated vocabulary. No ownership or recovery exists.

The one-time key is `af_v1.<128-bit lowercase-hex lookup>.<256-bit lowercase-hex
secret>`. Native Web Crypto supplies entropy, unbiased rejection sampling and
HMAC-SHA256 over the complete key. Native `timingSafeEqual` compares fixed-size
digests. Authentication uses a direct indexed lookup; unknown lookups perform a
dummy HMAC/comparison. This is not a constant-total-HTTP-latency guarantee.

Only lookup, HMAC digest and pepper version reach the atomic identity repository;
plaintext key material never does. Requested-name races receive 409. Generated
name collisions retry at most 32 complete candidates; indexed key/id collisions
retry at most four complete credentials, rolling back reservations on failure.
Exhaustion and unexpected failures are generic 500, never partial key issuance.
No endpoint returns an existing key. Authentication is a backend service for
future protected operations, not a new login/lookup/recovery endpoint.

## Server-only configuration

- `AUTH_CURRENT_PEPPER`: current version identifier (1–128 ASCII letters, digits,
  underscores or hyphens, without surrounding whitespace).
- `AUTH_PEPPERS`: JSON object mapping 1–8 version identifiers to 64 hex digits
  of server-held pepper material; the current identifier must exist.

These are secrets, not client configuration. Missing/malformed configuration
fails closed; there is no production fallback. Store them using the authorized
per-environment secret delivery path, never source control, logs, a client asset,
a URL or a Dockerfile. Rotation selects a new current version and retains each
old version needed to verify existing keys. Removing one invalidates its keys;
there is no automatic rehash, key reissue or recovery. Do not confuse this bounded
pepper configuration with the separate permanent cursor-key policy.

Owned local development creates a cryptographically random pepper in a mode-0600
`.dev.vars` beside its private temporary Wrangler config. Wrangler masks its
values. The file and disposable database share the session lifetime and are
cleaned on shutdown. Restarting development does not retain identities or keys.
No production/Actions secrets or cloud resources are created by this behavior.

## Verification boundaries

Actual workerd crypto tests, real PostgreSQL service tests and actual Worker
GET/POST requests verify issuance, auth, collisions, rollback, input/error
containment and method/lifecycle safety. The owned-local launcher test additionally
exercises network GET/POST against Wrangler with its fresh real database and
private credentials. Production-bundle smoke verifies module loading and the
existing runtime probes; it does not establish positive deployed registration.
Provider secret configuration, deployment, isolation and public activation remain
separate delivery/checkpoint evidence. No read/view tracking is added.
