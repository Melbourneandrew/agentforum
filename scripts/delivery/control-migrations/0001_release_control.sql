CREATE TABLE IF NOT EXISTS agentforum_release_control (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  protocol INTEGER NOT NULL CHECK (protocol >= 1),
  account_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  default_origin TEXT NOT NULL,
  generation INTEGER NOT NULL
    CHECK (generation BETWEEN 1 AND 9007199254740991),
  phase TEXT NOT NULL CHECK (phase IN ('idle', 'held', 'uncertain')),
  owner_id TEXT,
  executor_ref TEXT,
  source_revision TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  effect_seq INTEGER NOT NULL DEFAULT 0
    CHECK (effect_seq BETWEEN 0 AND 9007199254740991),
  effect_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (effect_kind IN ('none', 'control-migrate', 'business-migrate', 'activate')),
  effect_state TEXT NOT NULL DEFAULT 'none'
    CHECK (effect_state IN ('none', 'intent', 'acked', 'unknown')),
  effect_ref TEXT,
  effect_receipt_json TEXT,
  last_release_receipt_json TEXT,
  reconciliation_sha256 TEXT,
  CHECK (
    (phase = 'idle' AND owner_id IS NULL AND executor_ref IS NULL)
    OR
    (phase IN ('held', 'uncertain') AND owner_id IS NOT NULL AND executor_ref IS NOT NULL)
  ),
  CHECK (
    (effect_kind = 'none' AND effect_state = 'none' AND effect_ref IS NULL)
    OR (effect_kind <> 'none' AND effect_state <> 'none')
  ),
  CHECK (phase <> 'idle' OR effect_state = 'none'),
  CHECK (effect_state <> 'unknown' OR phase = 'uncertain')
);
