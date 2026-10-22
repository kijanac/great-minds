You are writing a wiki article for a knowledge base about a single topic. The article synthesizes a curated set of ideas — claim/quote pairs extracted from the knowledge base's source documents — into a coherent article written from within the sources' standpoint.

Start the article with a single `# Heading` line naming the topic. Use `##` subheadings for sections. Do NOT include YAML frontmatter — the system adds it.

## Grounding in sources

- Every substantive claim must be supported by a footnote referencing the numbered anchors below.
- Use the exact anchor numbers given. Do not invent, reorder, or renumber them.
- You may reuse an anchor number multiple times if the same quote supports multiple claims.
- Do NOT write the footnote resolution section at the bottom — the system produces it mechanically from your cited anchors.
- Cite across all contributing sources. If multiple documents contribute anchors, cite from more than one. An article that only draws from a single doc when many are available is incomplete.

## Internal linking

- Reference other topics via `[display text](wiki/<slug>.md)`.
- You may only link to slugs in "Related topics (linkable)" below. Never invent links.
- Link on first mention of each topic; do not repeat links for subsequent mentions.
- Do NOT use bold or italics as a substitute for linking.

## Editorial standards

- Write from within the standpoint the sources share, not as an outside analyst describing them. State their analysis directly, as knowledge — not as "X argues," "according to Y," or "the sources contend." The footnote carries provenance: a citation supports a claim; it does not own it.
- Name an author or text in the prose only when that is part of the content: a direct quotation, when or where a position was taken, or which side of a debate within the sources holds a view.
- Take positions as the sources hold them. Do not hedge toward neutrality or bring in outside perspectives. Where the sources genuinely disagree among themselves, present that debate.
- Preserve terminological distinctions from the sources — don't flatten distinct concepts.
- Length is proportional to evidence density. Typically 400-1200 words. Longer is fine when evidence supports a detailed treatment; don't pad.
- No preamble ("This article covers..."), no closing summary ("In conclusion..."), no commentary about the sources themselves, no frontmatter.

## Topic

Title: {title}
Description: {description}

## Ideas and anchors

{idea_block}

## Related topics (linkable)

{link_targets_block}

## Output

Return a JSON object with two fields:

```json
{
  "body": "# Topic Title\n\n...the markdown article body, starting with the # heading and ending at the final content paragraph (no footnote section, no frontmatter)...",
  "tags": ["tag-1", "tag-2", "tag-3"]
}
```

`body` is the article's markdown body following all the rules above.

`tags` is 3-6 short, lowercase, hyphen-separated keywords describing the article's subject (e.g. `imperialism`, `monopoly-capitalism`, `1916`, `lenin`). These power tag-based browsing and agent retrieval — pick concrete topical anchors, not generic categories. Avoid adjectives, full sentences, and umbrella terms like `concept` or `theory`.
