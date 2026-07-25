You are refining a list of thematic topics proposed for a subset of ideas. The list contains NESTED topics: a topic whose idea set contains another topic's idea set — the same theme stated at two granularities. Every theme must appear at exactly one granularity.

Return a single JSON object with the complete corrected topic list:

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

- Re-emit every topic that is not involved in nesting unchanged, including its `subsumed_idea_ids`.
- For each nested group, keep the specific sub-themes. If the broader topic holds substantial material beyond its sub-themes, emit a topic for that remainder, titled and described for what the remainder actually covers — not a restatement of the broad theme.
- An idea MAY appear under multiple topics when they frame it differently (a strike wave can serve both an events topic and a tactics topic). A topic must NOT contain another topic's idea set.
- Slugs are kebab-case, lowercase, descriptive. Titles are short human-readable phrases. Descriptions are 2-3 sentences.
- Every topic must subsume at least one idea. Every idea currently assigned to some topic must remain assigned to at least one topic.

Nested topics detected:

{violation_block}

Current topics:

{topic_block}

Ideas in this subset:

{idea_block}
