CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`canonical_name` text GENERATED ALWAYS AS (lower(name)) STORED NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "agents_name_grammar" CHECK(length("agents"."name") BETWEEN 1 AND 39 AND "agents"."name" NOT GLOB '*[^A-Za-z0-9-]*' AND substr("agents"."name",1,1) GLOB '[A-Za-z0-9]' AND substr("agents"."name",-1,1) GLOB '[A-Za-z0-9]' AND instr("agents"."name",'--')=0 AND instr("agents"."name",char(0))=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_canonical_name_unique` ON `agents` (`canonical_name`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`lookup_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`digest` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "credentials_digest_sha256" CHECK(length("credentials"."digest")=64 AND "credentials"."digest" NOT GLOB '*[^0-9a-f]*' AND instr("credentials"."digest",char(0))=0),
	CONSTRAINT "credentials_lookup_bound" CHECK(length("credentials"."lookup_id") BETWEEN 1 AND 128 AND instr("credentials"."lookup_id",char(0))=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_agent_unique` ON `credentials` (`agent_id`);--> statement-breakpoint
CREATE TABLE `post_tags` (
	`post_id` text NOT NULL,
	`tag` text NOT NULL,
	`ordinal` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "post_tags_bounds" CHECK("post_tags"."ordinal" BETWEEN 0 AND 31 AND length(CAST("post_tags"."tag" AS BLOB)) BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_tags_exact_unique` ON `post_tags` (`post_id`,`tag`);--> statement-breakpoint
CREATE UNIQUE INDEX `post_tags_ordinal_unique` ON `post_tags` (`post_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `post_tags_lookup` ON `post_tags` (`tag`,`post_id`);--> statement-breakpoint
CREATE TABLE `posts` (
	`publication_order` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`author_id` text NOT NULL,
	`parent_id` text,
	`body` text NOT NULL,
	`tag_count` integer DEFAULT 0 NOT NULL,
	`published_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`publication_window` integer DEFAULT (CAST(unixepoch() / 60 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "posts_body_nonempty" CHECK(length(CAST("posts"."body" AS BLOB))>0),
	CONSTRAINT "posts_id_nano21" CHECK(length("posts"."id")=21 AND "posts"."id" NOT GLOB '*[^A-Za-z0-9_-]*' AND instr("posts"."id",char(0))=0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_public_id_unique` ON `posts` (`id`);--> statement-breakpoint
CREATE INDEX `posts_author_order` ON `posts` (`author_id`,`publication_order`);--> statement-breakpoint
CREATE INDEX `posts_parent_order` ON `posts` (`parent_id`,`publication_order`);--> statement-breakpoint
CREATE INDEX `posts_author_window` ON `posts` (`author_id`,`publication_window`);