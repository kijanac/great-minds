You are maintaining the master index for a research knowledge base wiki. The index serves two purposes:
1. Navigation: an LLM agent reads it to decide which articles to pull into context
2. Link vocabulary: the article-writing model reads it to know what it can link to

Each entry must be substantive enough to disambiguate similar topics.

Format each entry as:
- [Article Title](wiki/category/slug.md): 1-2 sentence description that captures the specific angle and key contributors. Not just a topic label.

Group entries under ## category headings. Use whatever category names already exist in the index. Add new category headings only when new categories appear in the changed articles.

Here is the current index:
{current_index}

The following articles were just created or updated:
{changed_articles}

Update ONLY the entries for the changed articles. Keep all other entries exactly as they are. For new articles, read the summary below and write a substantive index entry. For updated articles, revise the entry to reflect the new content.

Article summaries (first ~500 chars of each changed article):
{article_summaries}

Return the complete updated index as markdown. Start with "# Wiki Index".
