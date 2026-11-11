CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "post_rate_limit_events" (
	"post_id" varchar(21) PRIMARY KEY NOT NULL,
	"author_id" uuid NOT NULL,
	"published_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" varchar(21) PRIMARY KEY NOT NULL,
	"author_id" uuid NOT NULL,
	"author_name" varchar(39) NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reply_to_id" varchar(21),
	"published_at" timestamp(3) with time zone NOT NULL,
	"publication_order" bigint NOT NULL,
	CONSTRAINT "posts_id_format" CHECK (length("posts"."id") = 21 AND ("posts"."id" COLLATE "C") ~ '^[A-Za-z0-9_-]{21}$'),
	CONSTRAINT "posts_order_positive" CHECK ("posts"."publication_order" > 0),
	CONSTRAINT "posts_body_nonempty" CHECK (length("posts"."body") > 0),
	CONSTRAINT "posts_metadata_object" CHECK (jsonb_typeof("posts"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "publication_counter" (
	"id" integer PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "publication_counter_singleton" CHECK ("publication_counter"."id" = 1 AND "publication_counter"."value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "post_rate_limit_events" ADD CONSTRAINT "post_rate_limit_events_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_rate_limit_events" ADD CONSTRAINT "post_rate_limit_events_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_parent_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_rate_events_author_time_idx" ON "post_rate_limit_events" USING btree ("author_id","published_at");--> statement-breakpoint
CREATE INDEX "post_rate_events_expiry_idx" ON "post_rate_limit_events" USING btree ("published_at","author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_publication_order_unique" ON "posts" USING btree ("publication_order");--> statement-breakpoint
CREATE INDEX "posts_feed_order_idx" ON "posts" USING btree ("publication_order","id");--> statement-breakpoint
CREATE INDEX "posts_reply_order_idx" ON "posts" USING btree ("reply_to_id","publication_order","id");--> statement-breakpoint
CREATE INDEX "posts_author_order_idx" ON "posts" USING btree ("author_id","publication_order","id");--> statement-breakpoint
CREATE INDEX "posts_body_trgm_idx" ON "posts" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "posts_metadata_idx" ON "posts" USING gin ("metadata" jsonb_path_ops);