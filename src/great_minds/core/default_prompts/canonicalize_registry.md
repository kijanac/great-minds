{thematic_hint_block}You are designing the canonical table of contents for a wiki built from a large corpus. Below are candidate sub-topics discovered in parallel across chunks of the corpus — each with a title, a short description, and the number of source ideas it covers. Many are near-duplicates of the same theme proposed independently from different chunks.

Reconcile them into the canonical set of wiki ARTICLE topics — one canonical topic becomes one wiki article. Your output defines the wiki's table of contents. Do NOT assign sub-topics here; only design the article set.

Return a single JSON object:

```
{
  "topics": [
    {
      "title": "Human-readable article title",
      "description": "1-2 sentences stating what this article covers.",
      "link_targets": ["Exact title of another topic in this output", "..."]
    }
  ]
}
```

Ground rules:

- Merge duplicates and near-duplicates into one coherent article-level topic — themes that say substantively the same thing, even when titles differ.
- Each topic is ONE coherent wiki article. Prefer coherent articles over both sprawling catch-alls and hair-splitting fragments.
- Aim for the natural number of articles for this material (typically 50–300); scale to the breadth of the corpus.
- Use the idea counts to judge scope: a theme covering a very large share of the ideas usually should be split into a few distinct articles rather than one umbrella; trivial themes can fold into a neighbour.
- Titles are short human-readable phrases, not sentences. Descriptions are 1–2 sentences on scope.
- `link_targets` reference OTHER topics in YOUR OWN output, by their EXACT title — meaningful thematic links only (a few per topic is typical; zero is fine for standalone themes). Never reference a title you did not emit.

Candidate sub-topics:

{local_topic_block}
