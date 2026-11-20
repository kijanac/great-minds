DELETE FROM "backlinks" WHERE "source_article_id" IN (SELECT "id" FROM "wiki_articles" WHERE "archived") OR "target_article_id" IN (SELECT "id" FROM "wiki_articles" WHERE "archived");
