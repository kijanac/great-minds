"""Extract summaries from article MD files and produce a digest via OpenRouter.

Usage:
    uv run scripts/digest_articles.py [articles_dir]

Reads all .md files in `articles/` (or the given dir), extracts title + summary,
and asks the model to cluster them into key events with categories and priorities.
"""

import json
import os
import re
import sys
from pathlib import Path

from openai import OpenAI

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
MODEL = "openai/gpt-5.4-nano"

SYSTEM_PROMPT = """\
You are an analyst synthesizing a news digest from a batch of article summaries.

Your job:
1. Identify the KEY EVENTS.
2. GROUP related articles under each event — multiple articles often cover the same story.
3. Assign a CATEGORY to each event (e.g. foreign_policy, domestic_politics, economy, \
health, law_justice, science, society, entertainment, conflict).
4. Assign a PRIORITY: high / medium / low based on significance and breadth of impact.
5. List article IDs to IGNORE — duplicates, fluff, celebrity gossip, or items with \
no substantive news content.

Respond with ONLY valid JSON. Schema:
{
  "events": [
    {
      "title": "<concise event title>",
      "category": "<category>",
      "priority": "high|medium|low",
      "summary": "<2-3 sentence synthesis of what's happening>",
      "article_ids": [<list of integer IDs from the input>]
    }
  ],
  "ignored_ids": [<list of integer IDs to discard>]
}

Rules:
- Every article ID must appear in exactly one event OR in ignored_ids.
- Order events by priority (high first), then by number of articles.
- Be aggressive about grouping: if two articles are clearly the same story, put them together.
- Be aggressive about ignoring low-value content.
"""


def strip_html(text: str) -> str:
    """Remove HTML tags and decode common entities."""
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&quot;", '"').replace("&#8230;", "…").replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", text).strip()


def extract_frontmatter(text: str) -> dict[str, str]:
    """Parse simple YAML-ish frontmatter between --- delimiters."""
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return {}
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip().strip('"')
    return meta


def extract_summary(text: str) -> str:
    """Pull text between '## Summary' and the next '## ' heading."""
    m = re.search(r"## Summary\s*\n(.*?)(?=\n## |\Z)", text, re.DOTALL)
    if not m:
        return ""
    return strip_html(m.group(1).strip())


def load_articles(articles_dir: Path) -> list[dict]:
    """Load title + summary from every .md file in the directory."""
    articles = []
    for i, path in enumerate(sorted(articles_dir.glob("*.md")), start=1):
        raw = path.read_text(encoding="utf-8")
        meta = extract_frontmatter(raw)
        title = meta.get("title", path.stem)
        summary = extract_summary(raw)
        if not summary:
            # Fall back to first sentence of full text
            m = re.search(r"## Full Text\s*\n(.+)", raw)
            if m:
                summary = strip_html(m.group(1).strip().split("\n")[0])
        articles.append(
            {
                "id": i,
                "title": title,
                "source": meta.get("source", ""),
                "summary": summary,
                "path": path.name,
            }
        )
    return articles


def build_user_message(articles: list[dict]) -> str:
    lines = [f"There are {len(articles)} articles. Analyze and cluster them.\n"]
    for a in articles:
        src = f" [{a['source']}]" if a["source"] else ""
        lines.append(f"[{a['id']}]{src} {a['title']}")
        if a["summary"]:
            lines.append(f"  {a['summary'][:400]}")
        lines.append("")
    return "\n".join(lines)


def call_model(user_message: str) -> dict:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY environment variable not set")

    client = OpenAI(base_url=OPENROUTER_BASE, api_key=api_key)
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        temperature=0.2,
        response_format={"type": "json_object"},
    )
    content = response.choices[0].message.content or "{}"
    return json.loads(content)


def render_digest(result: dict, articles: list[dict]) -> None:
    id_to_article = {a["id"]: a for a in articles}
    events = result.get("events", [])
    ignored = result.get("ignored_ids", [])

    priority_icon = {"high": "!!!", "medium": "-- ", "low": "   "}

    print(f"\n{'='*70}")
    print(f"  NEWS DIGEST  ({len(events)} events from {len(articles)} articles)")
    print(f"{'='*70}\n")

    for event in events:
        icon = priority_icon.get(event.get("priority", "low"), "   ")
        print(f"{icon} [{event.get('priority','?').upper()}] {event['title']}")
        print(f"    Category : {event.get('category','')}")
        print(f"    Summary  : {event.get('summary','')}")
        art_ids = event.get("article_ids", [])
        print(f"    Articles ({len(art_ids)}):")
        for aid in art_ids:
            a = id_to_article.get(aid)
            if a:
                src = f"[{a['source']}] " if a["source"] else ""
                print(f"      [{aid}] {src}{a['title']}")
        print()

    if ignored:
        print(f"--- IGNORED ({len(ignored)} articles) ---")
        for aid in ignored:
            a = id_to_article.get(aid)
            if a:
                print(f"  [{aid}] {a['title']}")
        print()

    # Coverage check
    all_output_ids = set()
    for event in events:
        all_output_ids.update(event.get("article_ids", []))
    all_output_ids.update(ignored)
    input_ids = {a["id"] for a in articles}
    missing = input_ids - all_output_ids
    if missing:
        print(f"[warn] {len(missing)} articles not accounted for: {sorted(missing)}")


def main() -> None:
    articles_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("articles")
    if not articles_dir.is_dir():
        print(f"Error: '{articles_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    print(f"Loading articles from {articles_dir.resolve()} …")
    articles = load_articles(articles_dir)
    print(f"Loaded {len(articles)} articles")

    if not articles:
        print("No articles found.")
        sys.exit(0)

    user_message = build_user_message(articles)
    token_estimate = len(user_message.split()) * 1.3
    print(f"Sending to {MODEL} (~{token_estimate:,.0f} tokens estimated) …")

    result = call_model(user_message)

    # Save raw JSON alongside
    out_path = Path("digest.json")
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"Raw JSON saved to {out_path.resolve()}")

    render_digest(result, articles)


if __name__ == "__main__":
    main()
