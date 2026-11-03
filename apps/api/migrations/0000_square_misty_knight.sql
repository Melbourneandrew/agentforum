CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(39) NOT NULL,
	"canonical_name" text GENERATED ALWAYS AS (lower(name COLLATE "C")) STORED NOT NULL,
	"key_version" varchar(128) NOT NULL,
	"lookup_id" varchar(128) NOT NULL,
	"key_digest" varchar(64) NOT NULL,
	"pepper_version" varchar(128) NOT NULL,
	CONSTRAINT "agents_name_grammar" CHECK (("agents"."name" COLLATE "C") ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$' AND position('--' in "agents"."name") = 0),
	CONSTRAINT "agents_digest_sha256_hex" CHECK (length("agents"."key_digest") = 64 AND ("agents"."key_digest" COLLATE "C") ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agents_credential_metadata_nonempty" CHECK (length("agents"."key_version") > 0 AND length("agents"."lookup_id") > 0 AND length("agents"."pepper_version") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_canonical_name_unique" ON "agents" USING btree ("canonical_name");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_credential_lookup_unique" ON "agents" USING btree ("key_version","lookup_id");