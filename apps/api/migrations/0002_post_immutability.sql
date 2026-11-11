-- Custom database invariants not represented by Drizzle's table snapshot.
INSERT INTO publication_counter (id, value) VALUES (1, 0);
--> statement-breakpoint
CREATE FUNCTION reject_post_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Published posts are immutable';
END;
$body$;
--> statement-breakpoint
CREATE TRIGGER posts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON posts
FOR EACH STATEMENT EXECUTE FUNCTION reject_post_mutation();
