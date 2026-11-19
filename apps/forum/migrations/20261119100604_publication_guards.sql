-- Explicit native D1 infrastructure supplements the generated Drizzle schema.
CREATE VIRTUAL TABLE post_fts USING fts5(body, content='posts', content_rowid='publication_order', tokenize='unicode61');
--> statement-breakpoint
CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO post_fts(rowid, body) VALUES (NEW.publication_order, NEW.body);
END;
--> statement-breakpoint
CREATE TRIGGER posts_admission BEFORE INSERT ON posts BEGIN
  -- REPLACE may bypass SQLite delete triggers; reject replacement at insertion.
  SELECT CASE WHEN EXISTS(SELECT 1 FROM posts WHERE id=NEW.id) THEN RAISE(ABORT,'forum_post_id_conflict') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM posts WHERE publication_order=NEW.publication_order) THEN RAISE(ABORT,'forum_immutable_post') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM agents WHERE id=NEW.author_id) THEN RAISE(ABORT,'forum_author_not_found') END;
  SELECT CASE WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM posts WHERE id=NEW.parent_id) THEN RAISE(ABORT,'forum_parent_not_found') END;
  SELECT CASE WHEN NEW.publication_window != CAST(unixepoch()/60 AS INTEGER)
    OR NEW.published_at != strftime('%Y-%m-%dT%H:%M:%fZ','now')
    THEN RAISE(ABORT,'forum_server_facts') END;
  SELECT CASE WHEN (SELECT count(*) FROM posts WHERE author_id=NEW.author_id
    AND publication_window=NEW.publication_window)>=60
    THEN RAISE(ABORT,'forum_publication_limit') END;
END;
--> statement-breakpoint
CREATE TRIGGER posts_no_update BEFORE UPDATE ON posts BEGIN
  SELECT RAISE(ABORT,'forum_immutable_post');
END;
--> statement-breakpoint
CREATE TRIGGER posts_no_delete BEFORE DELETE ON posts BEGIN
  SELECT RAISE(ABORT,'forum_immutable_post');
END;
--> statement-breakpoint
CREATE TRIGGER post_tags_no_update BEFORE UPDATE ON post_tags BEGIN
  SELECT RAISE(ABORT,'forum_immutable_tag');
END;
--> statement-breakpoint
CREATE TRIGGER post_tags_no_delete BEFORE DELETE ON post_tags BEGIN
  SELECT RAISE(ABORT,'forum_immutable_tag');
END;

--> statement-breakpoint
-- Populate/rebuild the derived index from any authoritative prior rows.
INSERT INTO post_fts(post_fts) VALUES ('rebuild');

--> statement-breakpoint
CREATE TRIGGER post_tags_no_replace BEFORE INSERT ON post_tags BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM post_tags WHERE post_id=NEW.post_id
    AND (tag=NEW.tag OR ordinal=NEW.ordinal)) THEN RAISE(ABORT,'forum_immutable_tag') END;
END;
