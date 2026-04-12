"""Extract summaries from article MD files and produce a digest via OpenRouter.

Usage:
    uv run scripts/digest_articles.py [articles_dir]

Phase 1a: identify events from articles.
Phase 1b: identify trends over those events (many-to-many mapping).
Phase 2:  tag each article with all associated events and trends.
"""

import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from openai import OpenAI
from tqdm import tqdm

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
MODEL = "deepseek/deepseek-v3.2"
TAG_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"

EDITORIAL_FOCUS = """\
EDITORIAL FOCUS — give high priority to:
  - Geopolitics and international relations (wars, diplomacy, sanctions, alliances)
  - Domestic politics (elections, legislation, government action, political movements)
  - Social movements, protests, labor, civil rights, and justice
  - Economics with political or societal consequence (trade wars, inequality, crashes)
  - Science, health, and environment with political or societal consequences
  - Technology with political or societal consequences

Deprioritize and ignore celebrity news, entertainment gossip, and sports unless they have clear political or social significance.
"""

EVENTS_SYSTEM_PROMPT = f"""\
You are an analyst synthesizing a serious news digest from a batch of article summaries.

{EDITORIAL_FOCUS}
Identify all discrete EVENTS from the articles: specific, concrete happenings anchored in time and place. If two articles clearly cover the same story, that is one event.
Do not create events for celebrity news, entertainment gossip, or sports unless they have direct political or social significance.

Respond with ONLY valid JSON. Schema:
{{
  "events": [
    {{
      "id": "<short snake_case id, e.g. 'china_tariff_retaliation'>",
      "title": "<concise event title>",
      "category": "<category: foreign_policy, domestic_politics, economy, health, \
law_justice, science, society, entertainment, conflict>",
      "priority": "high|medium|low",
      "summary": "<2-3 sentence synthesis of what's happening>"
    }}
  ]
}}

Rules:
- Order events by priority (high first).
- Be aggressive about grouping: if two articles clearly cover the same story, make one event.
"""

TRENDS_SYSTEM_PROMPT = """\
You are an analyst identifying trends across a set of pre-identified news events.

A TREND is a broader pattern, wave, or ongoing situation that spans multiple events
(e.g. "wave of labor strikes", "escalating US-China trade tensions").
Only create a trend when it genuinely ties several events together.
Each trend maps to one or more events. Each event can belong to multiple trends.

Respond with ONLY valid JSON. Schema:
{
  "trends": [
    {
      "id": "<short snake_case id, e.g. 'labor_unrest'>",
      "title": "<concise trend title>",
      "category": "<category: foreign_policy, domestic_politics, economy, health, \
law_justice, science, society, entertainment, conflict>",
      "priority": "high|medium|low",
      "summary": "<2-3 sentence description of the broader pattern or wave>",
      "event_ids": ["<event id>", ...]
    }
  ]
}

Rules:
- Order trends by priority (high first).
- Only use event IDs provided in the input.
"""

TAG_SYSTEM_PROMPT = """\
You are tagging a single news article against a pre-identified landscape of events and trends.

The digest prioritizes geopolitics, domestic politics, social movements, and consequential
economics. Celebrity news, entertainment gossip, and sports without political significance
should be ignored.

Given the article and the landscape, return which events and trends this article is associated
with. An article may belong to multiple events and/or multiple trends.
If the article is low-value, off-topic, or clearly unrelated to any identified event or trend,
set ignore to true.

Respond with ONLY valid JSON:
{
  "event_ids": ["<event id>", ...],
  "trend_ids": ["<trend id>", ...],
  "ignore": false
}
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


def build_articles_message(articles: list[dict]) -> str:
    lines = [f"There are {len(articles)} articles. Identify events.\n"]
    for a in articles:
        src = f" [{a['source']}]" if a["source"] else ""
        lines.append(f"[{a['id']}]{src} {a['title']}")
        if a["summary"]:
            lines.append(f"  {a['summary'][:400]}")
        lines.append("")
    return "\n".join(lines)


def build_trends_message(events: list[dict]) -> str:
    lines = [f"There are {len(events)} events. Identify trends across them.\n"]
    for e in events:
        lines.append(f"({e['id']}) [{e.get('priority','?').upper()}] {e['title']}")
        if e.get("summary"):
            lines.append(f"  {e['summary']}")
        lines.append("")
    return "\n".join(lines)


def build_tag_message(article: dict, events: list[dict], trends: list[dict]) -> str:
    # Build reverse map: event_id -> [trend_ids]
    event_trend_map: dict[str, list[str]] = {}
    for t in trends:
        for eid in t.get("event_ids", []):
            event_trend_map.setdefault(eid, []).append(t["id"])

    lines = ["LANDSCAPE EVENTS:"]
    for e in events:
        trend_tags = event_trend_map.get(e["id"], [])
        tags_str = f"trends: {trend_tags}" if trend_tags else "standalone"
        lines.append(f'  {e["id"]}: {e["title"]} ({tags_str})')

    lines.append("\nLANDSCAPE TRENDS:")
    for t in trends:
        lines.append(f'  {t["id"]}: {t["title"]}')

    lines.append(f'\nARTICLE [{article["id"]}]:')
    lines.append(f'Title: {article["title"]}')
    if article["source"]:
        lines.append(f'Source: {article["source"]}')
    if article["summary"]:
        lines.append(f'Summary: {article["summary"]}')

    return "\n".join(lines)


def make_client() -> OpenAI:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY environment variable not set")
    return OpenAI(base_url=OPENROUTER_BASE, api_key=api_key)


def _chat(
    client: OpenAI,
    model: str,
    system: str,
    user: str,
    log: list,
    phase: str,
    temperature: float = 0.0,
) -> tuple[str, float]:
    """Single chat completion with logging. Returns (content, elapsed_s)."""
    t0 = time.perf_counter()
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=temperature,
        response_format={"type": "json_object"},
    )
    elapsed = time.perf_counter() - t0
    content = response.choices[0].message.content or "{}"
    log.append({
        "phase": phase,
        "model": model,
        "system": system,
        "user": user,
        "response": content,
        "elapsed_s": round(elapsed, 2),
    })
    return content, elapsed


def call_events(client: OpenAI, user_message: str, log: list) -> tuple[list[dict], float]:
    content, elapsed = _chat(client, MODEL, EVENTS_SYSTEM_PROMPT, user_message, log, "events", temperature=0.2)
    return json.loads(content).get("events", []), elapsed


def call_trends(client: OpenAI, user_message: str, log: list) -> tuple[list[dict], float]:
    content, elapsed = _chat(client, MODEL, TRENDS_SYSTEM_PROMPT, user_message, log, "trends", temperature=0.2)
    return json.loads(content).get("trends", []), elapsed


def call_tag_article(client: OpenAI, tag_message: str, article_id: int, log: list) -> tuple[dict, float]:
    content, elapsed = _chat(client, TAG_MODEL, TAG_SYSTEM_PROMPT, tag_message, log, f"tag_{article_id}")
    return json.loads(content), elapsed


def print_landscape(events: list[dict], trends: list[dict]) -> None:
    priority_icon = {"high": "!!!", "medium": "-- ", "low": "   "}

    # Build reverse map: event_id -> [trend_ids]
    event_trend_map: dict[str, list[str]] = {}
    for t in trends:
        for eid in t.get("event_ids", []):
            event_trend_map.setdefault(eid, []).append(t["id"])

    print("\nTRENDS:")
    for t in trends:
        icon = priority_icon.get(t.get("priority", "low"), "   ")
        print(f"\n  {icon} [{t.get('priority','?').upper()}] ({t['id']}) {t['title']}")
        # print(f"      {t.get('summary', '')}")

    print("\nEVENTS:")
    for e in events:
        icon = priority_icon.get(e.get("priority", "low"), "   ")
        trend_tags = event_trend_map.get(e["id"], [])
        tags_str = f"  [{', '.join(trend_tags)}]" if trend_tags else ""
        print(f"\n  {icon} [{e.get('priority','?').upper()}] ({e['id']}) {e['title']}{tags_str}")
        # print(f"      {e.get('summary', '')}")
    print()


def render_digest(
    events: list[dict], trends: list[dict], articles: list[dict], ignored_ids: list[int]
) -> None:
    id_to_article = {a["id"]: a for a in articles}
    priority_icon = {"high": "!!!", "medium": "-- ", "low": "   "}

    # Build reverse map: event_id -> [trend_ids]
    event_trend_map: dict[str, list[str]] = {}
    for t in trends:
        for eid in t.get("event_ids", []):
            event_trend_map.setdefault(eid, []).append(t["id"])

    print(f"\n{'='*70}")
    print(
        f"  NEWS DIGEST  "
        f"({len(trends)} trends, {len(events)} events from {len(articles)} articles)"
    )
    print(f"{'='*70}\n")

    # Trends first (flat)
    if trends:
        print("TRENDS\n")
        for t in trends:
            icon = priority_icon.get(t.get("priority", "low"), "   ")
            print(f"{icon} [{t.get('priority','?').upper()}] {t['title']}")
            print(f"    Category : {t.get('category', '')}")
            print(f"    Summary  : {t.get('summary', '')}")
            art_ids = t.get("article_ids", [])
            if art_ids:
                print(f"    Articles ({len(art_ids)}):")
                for aid in art_ids:
                    a = id_to_article.get(aid)
                    if a:
                        src = f"[{a['source']}] " if a["source"] else ""
                        print(f"      [{aid}] {src}{a['title']}")
            print()

    # Events (flat, each tagged with its trends)
    print("EVENTS\n")
    for e in events:
        icon = priority_icon.get(e.get("priority", "low"), "   ")
        trend_tags = event_trend_map.get(e["id"], [])
        tags_str = f"  [{', '.join(trend_tags)}]" if trend_tags else ""
        print(f"{icon} [{e.get('priority','?').upper()}] {e['title']}{tags_str}")
        print(f"    Category : {e.get('category', '')}")
        print(f"    Summary  : {e.get('summary', '')}")
        art_ids = e.get("article_ids", [])
        if art_ids:
            print(f"    Articles ({len(art_ids)}):")
            for aid in art_ids:
                a = id_to_article.get(aid)
                if a:
                    src = f"[{a['source']}] " if a["source"] else ""
                    print(f"      [{aid}] {src}{a['title']}")
        print()

    if ignored_ids:
        print(f"--- IGNORED ({len(ignored_ids)} articles) ---")
        for aid in ignored_ids:
            a = id_to_article.get(aid)
            if a:
                print(f"  [{aid}] {a['title']}")
        print()

    # Coverage check
    all_tagged_ids: set[int] = set()
    for e in events:
        all_tagged_ids.update(e.get("article_ids", []))
    for t in trends:
        all_tagged_ids.update(t.get("article_ids", []))
    all_tagged_ids.update(ignored_ids)
    missing = {a["id"] for a in articles} - all_tagged_ids
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

    client = make_client()
    run_log: list[dict] = []
    run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Phase 1a: Identify events
    articles_message = build_articles_message(articles)
    token_estimate = len(articles_message.split()) * 1.3
    print(f"\nPhase 1a: events via {MODEL} (~{token_estimate:,.0f} tokens estimated) …")
    events, elapsed = call_events(client, articles_message, run_log)
    print(f"  → {len(events)} events ({elapsed:.1f}s)")

    # Phase 1b: Identify trends over those events
    trends_message = build_trends_message(events)
    print(f"\nPhase 1b: trends via {MODEL} …")
    trends, elapsed = call_trends(client, trends_message, run_log)
    print(f"  → {len(trends)} trends ({elapsed:.1f}s)")

    print_landscape(events, trends)

    # Phase 2: Tag each article with all associated events and trends
    events_map: dict[str, dict] = {e["id"]: {**e, "article_ids": []} for e in events}
    trends_map: dict[str, dict] = {t["id"]: {**t, "article_ids": []} for t in trends}
    ignored_ids: list[int] = []

    print(f"Phase 2: tagging {len(articles)} articles …")
    for article in tqdm(articles):
        print(f"  [{article['id']}/{len(articles)}] {article['title'][:60]} …", end=" ", flush=True)
        tag_message = build_tag_message(article, events, trends)
        tags, elapsed = call_tag_article(client, tag_message, article["id"], run_log)

        if tags.get("ignore"):
            ignored_ids.append(article["id"])
            print(f"ignored ({elapsed:.1f}s)")
        else:
            tagged_event_ids = tags.get("event_ids", [])
            tagged_trend_ids = tags.get("trend_ids", [])
            for eid in tagged_event_ids:
                if eid in events_map:
                    events_map[eid]["article_ids"].append(article["id"])
            for tid in tagged_trend_ids:
                if tid in trends_map:
                    trends_map[tid]["article_ids"].append(article["id"])
            parts = []
            if tagged_event_ids:
                parts.append(f"events={tagged_event_ids}")
            if tagged_trend_ids:
                parts.append(f"trends={tagged_trend_ids}")
            print(f"{', '.join(parts) if parts else 'untagged'} ({elapsed:.1f}s)")

    final_events = list(events_map.values())
    final_trends = list(trends_map.values())

    result = {
        "trends": final_trends,
        "events": final_events,
        "ignored_ids": ignored_ids,
    }

    out_path = Path("digest.json")
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"\nRaw JSON saved to {out_path.resolve()}")

    logs_dir = Path("logs")
    logs_dir.mkdir(exist_ok=True)
    log_path = logs_dir / f"{run_ts}.json"
    log_path.write_text(json.dumps(run_log, indent=2), encoding="utf-8")
    print(f"Run log saved to {log_path.resolve()}")

    render_digest(final_events, final_trends, articles, ignored_ids)


if __name__ == "__main__":
    main()
