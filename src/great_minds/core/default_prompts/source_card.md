# Source card extraction

You are analyzing a primary source text for knowledge-base compilation.
Read the document and return a single JSON object with exactly these
fields: `doc_metadata`, `ideas`, `anchors`.

## `doc_metadata`

Document-level properties:

- `genre`: short label for text type (e.g. "theoretical", "polemical",
  "historical", "strategic", "organisational"). Lowercase. Empty string
  if unclear.
- `tags`: 5-15 lowercase kebab-case tags for searchability. More specific
  than idea labels — names, events, themes, methods.
- `tradition`: short lowercase label for the intellectual or political
  tradition (e.g. "marxist-leninist", "anarchist", "liberal"). Empty
  string if unclear.
- `interlocutors`: thinkers or figures this text responds to or argues
  against. Empty list if none.

## `ideas`

Ideas this document expresses — concepts, people, events, organizations,
works, places, movements. Each idea is a contribution the doc makes
toward a potential wiki subject. Emit as many as the document
meaningfully supports, up to 15. Prefer fewer strong ideas to many weak
ones. Order by importance to the document.

- `id`: short local identifier for cross-referencing within this output
  only (convention: `i1`, `i2`, ...). Not a persistent ID.
- `label`: short canonical name. Prefer lowercase; preserve proper nouns
  and titles of works. Use the author's own terminology where possible.
- `kind`: one of `concept`, `person`, `event`, `organization`, `work`,
  `place`, `movement`, `other`.
- `scope_note`: one sentence defining what this idea is *as treated in
  this document*. Must distinguish it from related ideas. Do not
  restate the label.
- `anchor_refs`: 1-3 anchor `id`s from the `anchors` section that ground
  this idea. At least one is required.

## `anchors`

Supporting passages from the document. Each anchor is attached to the
whole source document (doc-level citation); no character offsets are
needed.

- `id`: short local identifier (convention: `a1`, `a2`, ...). Not a
  persistent ID.
- `claim`: one sentence describing what this passage establishes.
- `quote`: exact contiguous text from the document. Copy verbatim — do
  not paraphrase, trim, or alter punctuation or spacing. Must appear
  word-for-word in the source. Aim for 1-3 sentences of coherent
  content.

## Rules

- Return ONLY the JSON object. No markdown fencing, no preamble.
- Quotes must be exact substrings of the source text. If you cannot find
  a verbatim passage to support an idea, omit that idea.
- Scope notes must disambiguate, not paraphrase the label. If two ideas
  would share a scope_note, merge them into one.
- An idea with zero anchors is invalid.
