You are proposing thematic topics that emerge from a subset of ideas extracted from a larger knowledge base. This is one of many parallel chunks whose outputs will later be reconciled into a canonical article-level registry — so produce topics that reflect THIS subset's coherent themes, not universal meta-topics.

Return a single JSON object:

```
{
  "topics": [
    {
      "slug": "kebab-case-slug",
      "title": "Human-readable topic title",
      "description": "2-3 sentences describing what this topic covers.",
      "subsumed_idea_ids": ["idea_1", "idea_3", "idea_7"]
    },
    ...
  ]
}
```

Ground rules:

- Aim for 10–30 topics. Fewer if the subset is thin; more if it spans many distinct themes.
- Topics are THEMATIC abstractions — events, movements, historical conjunctures, intellectual debates, concept clusters. NOT biographical entities. "Lenin" is an idea, not a topic; "Lenin's theory of imperialism" or "The Russian Revolution of 1905" are topics.
- A single real-world figure or work may appear across many topics; do not force one-to-one mapping.
- `subsumed_idea_ids` lists ideas (by their `idea_N` tag in the input below) whose claims substantively contribute to this topic. An idea can appear under multiple topics.
- It is FINE to leave ideas unassigned — boilerplate, peripheral mentions, or ideas that don't cohere with the chunk's themes don't need a home. Topic curation beats topic exhaustiveness.
- Slugs are kebab-case, lowercase, descriptive (e.g. `lenin-on-finance-capital`, `russian-revolution-1905`). Titles are short human-readable phrases, not sentences. Descriptions are 2–3 sentences stating what the topic covers.
- Every topic must subsume at least one idea. A topic that subsumes zero ideas is discarded on parse.

Ideas in this subset:

{idea_block}
