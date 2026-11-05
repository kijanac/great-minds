ALTER TABLE "topic_related" RENAME COLUMN "shared_ideas" TO "shared_documents";--> statement-breakpoint
DELETE FROM "topic_related";--> statement-breakpoint
WITH "topic_documents" AS (
  SELECT DISTINCT m."topic_id", i."document_id"
  FROM "topic_membership" m
  JOIN "topics" t ON t."topic_id" = m."topic_id" AND t."article_status" <> 'archived'
  JOIN "ideas" i ON i."idea_id" = m."idea_id"
),
"sizes" AS (
  SELECT "topic_id", count(*)::int AS "size" FROM "topic_documents" GROUP BY 1
),
"pairs" AS (
  SELECT a."topic_id", b."topic_id" AS "related_topic_id", count(*)::int AS "shared"
  FROM "topic_documents" a
  JOIN "topic_documents" b ON b."document_id" = a."document_id" AND b."topic_id" <> a."topic_id"
  GROUP BY 1, 2
),
"ranked" AS (
  SELECT p."topic_id", p."related_topic_id", p."shared",
    p."shared"::double precision / (sa."size" + sb."size" - p."shared") AS "jaccard",
    row_number() OVER (
      PARTITION BY p."topic_id"
      ORDER BY p."shared"::double precision / (sa."size" + sb."size" - p."shared") DESC, p."related_topic_id"::text
    ) AS "rank"
  FROM "pairs" p
  JOIN "sizes" sa ON sa."topic_id" = p."topic_id"
  JOIN "sizes" sb ON sb."topic_id" = p."related_topic_id"
)
INSERT INTO "topic_related" ("topic_id", "related_topic_id", "shared_documents", "jaccard")
SELECT "topic_id", "related_topic_id", "shared", "jaccard" FROM "ranked" WHERE "rank" <= 20;
