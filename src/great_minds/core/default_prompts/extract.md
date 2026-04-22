You are extracting structured knowledge from a source document. Your output feeds downstream pipeline stages that map ideas into thematic articles, so precision and faithfulness to the source matter more than prose polish.

Return a single JSON object with exactly these fields:

- `title` (string): a clear, meaningful title for this document. Filenames are often uninformative placeholders — invent a title that captures what this document *is*. If the document has a clear natural title in its body (e.g. a pamphlet title, an article headline), use that.
- `doc_metadata` (object):
    - `genre` (string or null): what kind of document this is — e.g. "theoretical_pamphlet", "polemical_essay", "news_report", "biographical_sketch", "letter", "speech". Use snake_case. Null if genuinely unclear.
    - `tags` (array of strings): 2-6 short lowercase topical tags.
{extra_fields}
- `precis` (string): 2-3 sentences on what this document is doing — its argument or purpose, not just its topic.
- `ideas` (array of objects): specific factual things discussed in the document — people, events, organizations, concepts. Each idea:
    - `label` (string): a short canonical name for this thing as it appears in this document (e.g. "Lenin", "Paris Commune", "surplus value"). Use the form most consistent with how the document refers to it.
    - `kind` (string): one of the allowed kinds listed below. If nothing fits, use "other".
    - `description` (string): one sentence describing what this is, as treated in this document.
    - `anchors` (array of objects): 1-5 supporting claim-quote pairs, where
        - `anchor_id` (string): a short identifier unique within this idea (e.g. "a1", "a2")
        - `claim` (string): a clear paraphrase of what the document says about this idea at this location
        - `quote` (string): the verbatim supporting text from the document. Must appear in the source exactly as written.

Ground rules:

- Every claim in every anchor must be supported by its verbatim quote. Do not invent claims the document does not make.
- Ideas are per-document, not canonical across the corpus. "Lenin" in this document is a separate idea from "Lenin" in another document. Do not collapse or deduplicate across documents.
- Prefer extracting fewer, higher-quality ideas with well-chosen anchors over many thinly-anchored ideas. Aim for 5-20 ideas per document for typical documents; fewer for short or thin documents.
- Quotes should be substantive enough to support the claim but not so long they become unwieldy. Aim for a single sentence or short passage per anchor.
- If the document is very short, sparse, or not substantively about any specific ideas, return few or no ideas — an empty ideas array is acceptable.

Allowed kinds: {kinds}

Source type: {source_type}

Document:

```
{doc_content}
```
