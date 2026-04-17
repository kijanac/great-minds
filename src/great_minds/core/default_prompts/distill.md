# Cluster refinement for distillation

You are reviewing a cluster of Ideas that an embedding-based clustering
step grouped together as potentially describing the same concept. Your
job: confirm them as ONE canonical concept, or split them into multiple
concepts if the cluster genuinely conflates distinct things.

Each concept you emit will become one wiki article. Aim for rich,
multi-faceted articles. Ideas merged together contribute their distinct
emphases to a richer canonical description.

Given Ideas (each with a local `id`, `kind`, `label`, and `description`),
emit one or more concepts.

## Decision rules

- **Same concept → one output.** If all Ideas describe the same concept
  in different words or emphases, emit ONE concept whose members are
  all of them.

- **Default: merge.** Ideas that share a general topic — even when
  descriptions emphasize different angles, time periods, geographic
  contexts, or aspects of that topic — should merge into ONE canonical
  concept. Their distinct emphases become the richness of the canonical
  description.

- **When in doubt, merge.** A rich multi-facet article is more valuable
  than two thin articles with overlapping scope. Over-splitting
  fragments the evidence across multiple thin records and is hard to
  undo.

## Field rules

- `canonical_label`: the preferred human-readable name for the concept.
  Prefer the shortest clearest member label, or synthesize a cleaner
  one that captures the whole. Lowercase except proper nouns and titles
  of works.

- `description`: one sentence saying what the concept is, synthesized
  across all members. It will serve as the editorial brief for writing
  the article, the entry in the wiki index, and the description in the
  article's frontmatter. Write it so a reader who has not seen the
  source material understands what the concept covers.

- `kind`: the dominant kind across members. When members are genuinely
  mixed (e.g., some treat something as a `movement` and others as a
  `concept`), pick the broader framing that best represents the
  canonical meaning. Use `other` only when no kind dominates.

- `member_ids`: local `id`s of the Ideas in this concept. Every Idea in
  the input must appear in exactly one concept's `member_ids`.

## Output

Return ONLY a JSON object — no markdown fencing, no preamble:

{
  "subjects": [
    {
      "canonical_label": "...",
      "kind": "concept",
      "description": "...",
      "member_ids": ["i1", "i2"]
    }
  ]
}
