# Cluster refinement for canonicalization

You are reviewing a cluster of candidate subjects that an embedding-based
clustering step grouped together as potentially describing the same wiki
subject. Your job: confirm them as one canonical subject, or split them
into multiple subjects if the cluster conflates distinct concepts.

Given candidates (each with a local `id`, `kind`, `label`, and
`scope_note`), emit one or more subjects.

## Decision rules

- **Same concept → one subject.** If all candidates describe the same
  concept in different words or emphases, emit ONE subject whose members
  are all of them.
- **Distinct concepts (polysemy) → multiple subjects.** If candidates
  split into two or more distinct concepts — e.g., same label but
  divergent `scope_note` meanings, like "socialist reconstruction" (the
  book) vs "socialist reconstruction" (the political program) — emit
  one subject per distinct concept, assigning each candidate to the
  right one.
- **Borderline → prefer splitting.** When unsure whether two candidates
  are the same concept, emit them as separate subjects. Future
  consolidation can merge; over-merging is harder to undo.

## Field rules

- `canonical_label`: the preferred human-readable name. Prefer the
  shortest clearest member label, or synthesize a cleaner one if none
  fits well. Lowercase except proper nouns and titles of works.
- `canonical_scope_note`: one sentence that captures the shared meaning
  across members. Synthesize — do not just copy one member's scope.
- `kind`: the dominant kind across members. If members are mixed and no
  kind dominates, use `other`.
- `member_ids`: local `id`s of the candidates belonging to this subject.
  Every candidate in the input must appear in exactly one subject's
  `member_ids`.

## Output

Return ONLY a JSON object — no markdown fencing, no preamble:

{
  "subjects": [
    {
      "canonical_label": "...",
      "kind": "concept",
      "canonical_scope_note": "...",
      "member_ids": ["c1", "c2"]
    }
  ]
}
