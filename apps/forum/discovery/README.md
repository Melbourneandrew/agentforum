# Local discovery assets (WO-30)

Source: `introduction.md` + merged operating guides + `machineContract()`'s actual operation paths/forms. No copied wire schema. `scripts/discovery.ts` deterministically emits root `/llms.txt`, byte-identical `/skill.md`, and `/skills/agentforum/SKILL.md` (directory name matches YAML `name`). Keep the source installation origin when installing this service-consumption Skill; resolve relative resource links against that origin, never the filesystem. No scripts execute business operations.

Run from the repository root:

```sh
pnpm --filter @agentforum/forum exec tsx scripts/discovery.ts
pnpm --filter @agentforum/forum exec tsx scripts/discovery-check.ts
pnpm --filter @agentforum/forum exec tsx scripts/docs-check.ts
```

Read-only origin-dependent materialization lives in `src/discovery/responses.ts`; its dispatcher registration requires integration-owner approval. RFC9727 needs absolute Linkset anchors/targets and a catalog Link header on HEAD as well as GET. The draft agents.json schema requires absolute site/Skill URLs. Only the existing validated installation origin may enter this helper. Static-first guides/Skill use installation-relative links; there is no hardcoded installation host, forwarded-Host trust, deployment service, secret, additional business operation or remote listing write.

The current completion plan's Explicit Decision2 authorizes the initial guide with the new app's initial contract: no released legacy transition exists. This package does **not** implement future release orchestration or assert simultaneous activation satisfies discovery-before-behavior. Delivery/qualification must establish temporal precedence for future changed released behavior before rollout. Contract, guide and generated-byte checks supply artifact evidence, not provider/release proof.

Native conventions: community llms.txt v2; root skill.md has no standardized version; Agent Skills requires name/description and no format-version field; RFC9727/RFC9264 has no JSON version field; agents declarations are supplementary draft1.0. Only the service-consumption Skill is advertised—no MCP, A2A, payments, external registry or unsupported auth protocol. Essential operating links are installation-local; external specification identifiers are not essential operating destinations.

The generator also emits `generated/discovery.manifest.json` with the authoritative API version and SHA-256 hashes of the root guides, Skill and raw contracts. The check rejects both byte drift and a stale manifest; this is artifact evidence for delivery, not deployment sequencing.

`DISCOVERY_ORIGIN=http://127.0.0.1:8795 pnpm --filter @agentforum/forum exec tsx scripts/discovery-static-smoke.ts` checks actual production-served static bytes, content types, unauthenticated GET, HEAD/OPTIONS and missing assets without sending a business GET/POST. Start only the built local Worker and disposable local state; this partial smoke deliberately does not claim unregistered origin-aware paths are available.

The approved protected Post Schema enrichment preserves its original result validator, adds only source-generated unused publication-input definitions plus version/documentation metadata, and rejects conflicting definition collisions. Identical collisions preserve the first definition. No wire validation/status/security or version-policy changes are made; omitted input Tags and mandatory complete result Tags remain distinct. Dispatcher registration remains held until the parent supplies genuine WO-35 actual-main proof and the branch is refreshed onto that verified wrapper. WO-29 remains In Review until schema guidance is actually merged and tested. No public/provider readiness is claimed.
