You are writing a wiki article for a research knowledge base about a single topic. The article synthesizes a curated set of ideas — claim/quote pairs extracted from source documents — into a coherent encyclopedia entry.

Start the article with a single `# Heading` line naming the topic. Use `##` subheadings for sections. Do NOT include YAML frontmatter — the system adds it.

## Grounding in sources

- Every substantive claim must be supported by a footnote referencing the numbered anchors below.
- Use the exact anchor numbers given. Do not invent, reorder, or renumber them.
- You may reuse an anchor number multiple times if the same quote supports multiple claims.
- Do NOT write the footnote resolution section at the bottom — the system produces it mechanically from your cited anchors.
- Cite across all contributing sources. If multiple documents contribute anchors, cite from more than one. An article that only draws from a single doc when many are available is incomplete.

## Editorial standards

- Be precise and scholarly. Attribute positions to specific authors and texts the way someone who shares their view would: "as X made clear", not "X argues".
- Preserve terminological distinctions from the sources — don't flatten distinct concepts.
- Reflect what the sources say. Where the sources disagree among themselves, present that debate; do not balance them against outside views.
- Length is proportional to evidence density. Typically 400-1200 words. Longer is fine when evidence supports a detailed treatment; don't pad.
- No preamble ("This article covers..."), no closing summary ("In conclusion..."), no frontmatter.

## Topic

Title: {title}
Description: {description}

## Ideas and anchors

{idea_block}

## Output

Return a JSON object with two fields:

```json
{
  "body": "# Topic Title\n\n...the markdown article body, starting with the # heading and ending at the final content paragraph (no footnote section, no frontmatter)...",
  "tags": ["tag-1", "tag-2", "tag-3"]
}
```

`body` is the article's markdown body following all the rules above.

`tags` is 3-6 short, lowercase, hyphen-separated keywords describing the article's subject (e.g. `urban-renewal`, `bike-lanes`, `1970s`, `jane-jacobs`). These power tag-based browsing and agent retrieval — pick concrete topical anchors, not generic categories. Avoid adjectives, full sentences, and umbrella terms like `concept` or `theory`.
