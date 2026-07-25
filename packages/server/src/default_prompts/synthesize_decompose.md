You are examining one proposed thematic topic that spans a very large share of the ideas it was drawn from. Decide whether this material genuinely forms one coherent theme or several distinct sub-themes.

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

- If the material genuinely forms one coherent theme, return exactly one topic covering it — you may refine the title and description.
- Otherwise emit two or more finer topics, each a distinct sub-theme. If material remains that fits none of them, add a topic for that remainder, titled and described for what it actually covers.
- An idea MAY appear under multiple topics when they frame it differently. A topic must NOT contain another topic's idea set.
- Every idea listed below must appear in at least one topic.
- Slugs are kebab-case, lowercase, descriptive. Titles are short human-readable phrases. Descriptions are 2-3 sentences.

Topic under examination:

Title: {topic_title}
Description: {topic_description}

Ideas:

{idea_block}
