ALTER TABLE "topics" DROP COLUMN "supersedes";--> statement-breakpoint
ALTER TABLE "topics" DROP CONSTRAINT "ck_topics_article_status", ADD CONSTRAINT "ck_topics_article_status" CHECK ("article_status" in ('no_article', 'rendered', 'archived'));--> statement-breakpoint
DELETE FROM "topic_membership" WHERE "topic_id" IN (SELECT "topic_id" FROM "topics" WHERE "article_status" = 'archived');--> statement-breakpoint
DELETE FROM "topic_links" WHERE "source_topic_id" IN (SELECT "topic_id" FROM "topics" WHERE "article_status" = 'archived') OR "target_topic_id" IN (SELECT "topic_id" FROM "topics" WHERE "article_status" = 'archived');--> statement-breakpoint
DELETE FROM "topic_related" WHERE "topic_id" IN (SELECT "topic_id" FROM "topics" WHERE "article_status" = 'archived') OR "related_topic_id" IN (SELECT "topic_id" FROM "topics" WHERE "article_status" = 'archived');
