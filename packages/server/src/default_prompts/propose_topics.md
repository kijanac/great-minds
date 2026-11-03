You are proposing thematic topics that one source document contributes to, from the ideas extracted from it. This is one of many documents processed separately; topics proposed by different documents will later be recognised as the same and reconciled into a canonical article-level registry — so name each topic the way the whole knowledge base would, not the way this document happens to frame it, and propose only topics THIS document substantively contributes to, not universal meta-topics.

Return a single JSON object:

```
{
  "topics": [
    {
      "slug": "kebab-case-slug",
      "title": "Human-readable topic title",
      "description": "2-3 sentences describing what this topic covers, and what it leaves to neighbouring topics.",
      "inclusion_test": "One sentence: an idea belongs to this topic if ...",
      "subsumed_idea_ids": ["idea_1", "idea_3", "idea_7"]
    },
    ...
  ],
  "set_aside": [
    {"idea_id": "idea_5", "reason": "bookkeeping"}
  ]
}
```

Ground rules:

- Most documents contribute to 1–4 topics, but propose as many as the document's substantive ideas need: an idea whose claims say something about a subject belongs under a topic for that subject. Fewer if the document is thin.
- Topics are THEMATIC abstractions — events, movements, historical conjunctures, intellectual debates, concept clusters. NOT biographical entities. "Lenin" is an idea, not a topic; "Lenin's theory of imperialism" or "The Russian Revolution of 1905" are topics.
- A topic must be specific enough that one article could cover it, and broad enough that other documents in the knowledge base could contribute to it. Not this document's occasion or genre (a particular letter, speech or meeting), and not a catch-all.
- A single real-world figure or work may appear across many topics; do not force one-to-one mapping.
- `subsumed_idea_ids` lists ideas (by their `idea_N` tag in the input below) whose claims substantively contribute to this topic. An idea can appear under multiple topics when they frame it differently — a strike wave can serve both an events topic and a tactics topic.
- Every theme appears at exactly ONE granularity. When a broad theme divides into distinct sub-themes, emit the sub-themes; add a topic for the remaining material only if it is substantial, titled for what that remainder actually covers. Never emit a topic whose idea set restates the union of other topics in your list — a topic must not contain another topic.
- Account for every idea: each idea goes under at least one topic or into `set_aside`. Set aside only ideas whose claims give a topic nothing to use: `bookkeeping` (addressees, dates, delivery, publication details), `passing mention` (named, but the document says nothing about it; an idea mentioned briefly is not a passing mention if its claims say something), or `not thematic` (says something, but about nothing a topic of this knowledge base would cover).
- Slugs are kebab-case, lowercase, descriptive (e.g. `lenin-on-finance-capital`, `russian-revolution-1905`). Titles are short human-readable phrases, not sentences. Descriptions are 2–3 sentences stating what the topic covers and what it leaves to neighbouring topics.
- Every topic must subsume at least one idea. A topic that subsumes zero ideas is discarded on parse.

The document, with each idea followed by the claims it makes about it:

{idea_block}
