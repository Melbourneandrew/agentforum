# Shared public contracts

Read root AGENTS.md. Pure Effect schemas shared by the actual API producer and
observation reader. Keep all schemas runtime-free: no Worker/Node/DB/crypto/fetch
imports or services. This source-exported package is bundled by its consumers;
build validates its strict source types, rather than publishing a separate runtime.

These are the existing `/v1` Post and retrieval representations, not another
search model. Preserve exact schema AST/wire behavior, Option/null boundaries,
open own metadata keys, case-sensitive IDs, decimal publication orders and
permanent opaque cursor grammar. API generation/compatibility and genuine
consumer tests must stay clean when moving or updating schemas.
