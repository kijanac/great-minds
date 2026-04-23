{thematic_hint_block}You are consolidating local thematic topics (proposed in parallel across chunks of a larger knowledge base) into a canonical article-level registry. One canonical topic becomes one wiki article. Your output defines the wiki's table of contents.

Return a single JSON object:

```
{
  "canonical_topics": [
    {
      "slug": "kebab-case-slug",
      "title": "Human-readable topic title",
      "description": "2-3 sentences describing what this topic covers.",
      "merged_local_topic_ids": ["lt_17", "lt_34", "lt_62"],
      "link_targets": ["other-canonical-slug", "another-canonical-slug"]
    },
    ...
  ]
}
```

Ground rules:

- Every local topic must appear in exactly one `merged_local_topic_ids` list. You have global view across the corpus — merge local topics whose thematic content is substantively the same even if slugs and titles differ.
- A canonical topic may subsume one or many local topics.
- Prefer fewer coherent canonical topics over many fine-grained ones. Aim for 50–300 canonical topics for a typical corpus; scale proportionally for smaller or larger inputs.
- `slug` is kebab-case, lowercase, descriptive (e.g. `lenin-on-finance-capital`, `russian-revolution-1905`). `title` is a clear human-readable phrase, not a sentence. `description` states what this topic covers in 2–3 sentences.
- `link_targets` lists slugs of OTHER canonical topics (from within this same response) that THIS article should reference. Forward references are fine — you may link to a slug defined later in the output. Include only meaningful thematic links, not every co-occurrence. A few to a dozen targets per topic is a typical range; zero is acceptable for truly standalone themes.
- Every canonical topic must subsume at least one local topic.

Pre-merged local topics:

{local_topic_block}
