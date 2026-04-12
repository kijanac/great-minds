"""Two-layer editorial scoring: LLM feature extraction + learned linear scorer.

Architecture:
  Layer 1 — Feature extraction (LLM)
    Extracts a structured feature vector per event/trend using world knowledge:
    scope, actor type, development type, affected population estimate, urgency, etc.

  Layer 2 — Learned linear scorer
    A linear model maps the normalized feature vector to a 0–100 priority score.
    Initialized with domain-knowledge priors; updated online from editor feedback
    via SGD so the model adapts to outlet-specific priorities over time.

  Layer 3 — Online feedback
    Editor up/downvotes on individual items drive weight updates. With a linear
    model, one gradient step per feedback event is sufficient.

Usage:
    uv run scripts/score_digest.py                         # extract + score latest run
    uv run scripts/score_digest.py --force                 # re-extract features even if cached
    uv run scripts/score_digest.py feedback event <id> up  # upvote an event
    uv run scripts/score_digest.py feedback trend <id> down
"""

import json
import math
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

from openai import OpenAI

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
MODEL = "deepseek/deepseek-v3.2"
DB_PATH = Path("digest.db")

# ---------------------------------------------------------------------------
# Feature schema
# ---------------------------------------------------------------------------

FEATURE_NAMES = [
    "scope",           # local→international
    "dev_type",        # continuation→novel_event
    "population_log",  # log10 of people affected
    "urgency",         # slow_burn→breaking
    "arc",             # closing→opening/turning_point
    "struct_sig",      # surface→systemic
    "contrarian",      # 0/1
    "source_div",      # single_origin→cross_domain
    "data_avail",      # sparse→rich
    "n_articles",      # hard signal: coverage count
    "n_connections",   # hard signal: len(connects_to_ongoing)
    "n_events",        # hard signal: events under this trend (0 for events)
]

SCOPE_ORD       = {"local": 1, "regional": 2, "national": 3, "international": 4}
DEV_TYPE_ORD    = {"continuation": 0, "resolution": 1, "milestone": 2,
                   "policy_change": 3, "revelation": 3, "turning_point": 4,
                   "escalation": 4, "novel_event": 5}
URGENCY_ORD     = {"slow_burn": 1, "this_week": 2, "developing": 3, "breaking": 4}
ARC_ORD         = {"closing": 1, "middle": 2, "opening": 3, "turning_point": 3}
STRUCT_SIG_ORD  = {"surface": 1, "symptomatic": 2, "systemic": 3}
SOURCE_DIV_ORD  = {"single_origin": 1, "wire_only": 2, "multi_outlet": 3, "cross_domain": 4}
DATA_AVAIL_ORD  = {"sparse": 1, "moderate": 2, "rich": 3}

# (min, max) for per-feature normalization to [0, 1]
FEATURE_RANGES = [
    (1, 4),   # scope
    (0, 5),   # dev_type
    (1, 9),   # population_log
    (1, 4),   # urgency
    (1, 3),   # arc
    (1, 3),   # struct_sig
    (0, 1),   # contrarian
    (1, 4),   # source_div
    (1, 3),   # data_avail
    (0, 20),  # n_articles (capped)
    (0, 10),  # n_connections (capped)
    (0, 10),  # n_events (capped)
]

# Initial weights — higher for features that matter most editorially.
# Normalized to sum to 1 so the dot product stays in [0, 1].
_RAW_WEIGHTS = [
    1.0,   # scope
    1.5,   # dev_type
    2.0,   # population_log — single most important signal
    1.5,   # urgency
    0.5,   # arc
    1.0,   # struct_sig
    0.5,   # contrarian
    0.5,   # source_div
    0.3,   # data_avail
    0.6,   # n_articles
    0.3,   # n_connections
    0.3,   # n_events
]
_W_SUM = sum(_RAW_WEIGHTS)
INITIAL_WEIGHTS = [w / _W_SUM for w in _RAW_WEIGHTS]

# ---------------------------------------------------------------------------
# Feature extraction prompt
# ---------------------------------------------------------------------------

FEATURE_EXTRACTION_PROMPT = """\
You are a feature extractor for an editorial prioritization system. Given a batch of
events or trends detected by our monitoring system, extract structured features for each.

Each input item includes: id, type, category (first-pass label), summary, n_sources.

Output a JSON object:
{
  "features": [
    {
      "id": "<same id as input>",
      "topic_tags": [],
      "scope": "",
      "actor_type": "",
      "development_type": "",
      "affected_population_log_order": 0,
      "temporal_urgency": "",
      "narrative_arc": "",
      "structural_significance": "",
      "contrarian_potential": false,
      "connects_to_ongoing": [],
      "data_availability": "",
      "source_diversity": "",
      "one_line_angle": ""
    }
  ]
}

FIELD DEFINITIONS:
  topic_tags                  2-5 tags from the vocabulary below
  scope                       "local" | "regional" | "national" | "international"
  actor_type                  "government" | "corporate" | "labor" | "grassroots" |
                              "institutional" | "individual" | "military" | "multilateral"
  development_type            "novel_event" | "escalation" | "resolution" |
                              "policy_change" | "revelation" | "milestone" | "continuation"
  affected_population_log_order  log10 estimate of people materially affected.
                              Workplace dispute ≈ 2, national policy change ≈ 7-8.
  temporal_urgency            "breaking" | "developing" | "this_week" | "slow_burn"
  narrative_arc               "opening" | "middle" | "turning_point" | "closing"
  structural_significance     "surface" (discrete event) | "symptomatic" (instance of pattern) |
                              "systemic" (challenges underlying structures)
  contrarian_potential        true only if you can articulate an underreported angle in one_line_angle
  connects_to_ongoing         short phrases matching active story threads (e.g. "UAW contract negotiations")
  data_availability           "rich" | "moderate" | "sparse"
  source_diversity            "single_origin" | "wire_only" | "multi_outlet" | "cross_domain"
  one_line_angle              One sentence: what would make this worth covering beyond existing framing?
                              If nothing, say "No clear differentiated angle."

TOPIC TAG VOCABULARY:
labor, housing, healthcare, education, climate, immigration, criminal_justice, tech_policy,
economic_policy, fiscal_policy, trade, military_foreign_policy, elections, civil_rights,
corporate_governance, financial_markets, energy, infrastructure, public_health, media,
science, demographics, judiciary, regulation, social_policy

GUIDELINES:
- Be concrete on affected_population_log_order. Don't round up for drama.
- contrarian_potential = true only when you can actually state the angle.
- development_type "continuation" is an important deprioritization signal — use it when
  nothing meaningfully new has happened.
- structural_significance is analytical depth, not importance. A massive earthquake is
  "surface". A pattern of regulatory failures is "symptomatic".
- Output one object per input item, in the same order.
"""


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def init_db(db_path: Path) -> None:
    """Extend the digest DB with scoring-related tables and columns."""
    con = sqlite3.connect(db_path)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS model_weights (
            id          TEXT PRIMARY KEY,
            weights     TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS feedback (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            run_ts      TEXT NOT NULL,
            item_type   TEXT NOT NULL,
            item_id     TEXT NOT NULL,
            direction   TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );
    """)
    for table in ("events", "trends"):
        try:
            con.execute(f"ALTER TABLE {table} ADD COLUMN features TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
    con.commit()
    con.close()


def load_latest_run(db_path: Path) -> tuple[str, list[dict], list[dict]]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    row = con.execute("SELECT run_ts FROM runs ORDER BY run_ts DESC LIMIT 1").fetchone()
    if not row:
        raise RuntimeError("No runs found in database. Run digest_articles.py first.")
    run_ts = row["run_ts"]

    events = [dict(r) for r in con.execute("SELECT * FROM events WHERE run_ts=?", (run_ts,))]
    trends = [dict(r) for r in con.execute("SELECT * FROM trends WHERE run_ts=?", (run_ts,))]
    con.close()

    for e in events:
        e["article_ids"] = json.loads(e["article_ids"] or "[]")
        e["features"] = json.loads(e["features"] or "null")
    for t in trends:
        t["event_ids"] = json.loads(t["event_ids"] or "[]")
        t["article_ids"] = json.loads(t["article_ids"] or "[]")
        t["features"] = json.loads(t["features"] or "null")

    return run_ts, events, trends


def save_features(db_path: Path, run_ts: str, item_id: str, table: str, features: dict) -> None:
    con = sqlite3.connect(db_path)
    con.execute(
        f"UPDATE {table} SET features=? WHERE run_ts=? AND id=?",
        (json.dumps(features), run_ts, item_id),
    )
    con.commit()
    con.close()


def save_score(db_path: Path, run_ts: str, item_id: str, table: str, score: float) -> None:
    con = sqlite3.connect(db_path)
    con.execute(
        f"UPDATE {table} SET score=? WHERE run_ts=? AND id=?",
        (round(score, 1), run_ts, item_id),
    )
    con.commit()
    con.close()


def load_weights(db_path: Path) -> list[float]:
    con = sqlite3.connect(db_path)
    row = con.execute("SELECT weights FROM model_weights WHERE id='scorer'").fetchone()
    con.close()
    return json.loads(row[0]) if row else list(INITIAL_WEIGHTS)


def save_weights(db_path: Path, weights: list[float]) -> None:
    con = sqlite3.connect(db_path)
    con.execute(
        "INSERT OR REPLACE INTO model_weights VALUES ('scorer', ?, ?)",
        (json.dumps(weights), datetime.now().isoformat()),
    )
    con.commit()
    con.close()


def log_feedback(db_path: Path, run_ts: str, item_type: str, item_id: str, direction: str) -> None:
    con = sqlite3.connect(db_path)
    con.execute(
        "INSERT INTO feedback (run_ts,item_type,item_id,direction,created_at) VALUES (?,?,?,?,?)",
        (run_ts, item_type, item_id, direction, datetime.now().isoformat()),
    )
    con.commit()
    con.close()


# ---------------------------------------------------------------------------
# Feature extraction (Layer 1)
# ---------------------------------------------------------------------------

def build_extraction_message(items: list[dict], kind: str) -> str:
    lines = [f"Extract features for these {len(items)} {kind}s:\n"]
    for item in items:
        n_src = len(item.get("article_ids", []))
        n_ev = len(item.get("event_ids", []))
        lines.append(f"id: {item['id']}")
        lines.append(f"type: {kind}")
        lines.append(f"category: {item.get('category', '')}")
        lines.append(f"first_pass_priority: {item.get('priority', '')}")
        lines.append(f"summary: {item.get('summary', '')}")
        lines.append(f"n_sources: {n_src}" + (f"  n_events: {n_ev}" if kind == "trend" else ""))
        lines.append("")
    return "\n".join(lines)


def call_features(client: OpenAI, items: list[dict], kind: str) -> tuple[list[dict], float]:
    t0 = time.perf_counter()
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": FEATURE_EXTRACTION_PROMPT},
            {"role": "user", "content": build_extraction_message(items, kind)},
        ],
        temperature=0.0,
        response_format={"type": "json_object"},
    )
    elapsed = time.perf_counter() - t0
    content = response.choices[0].message.content or "{}"
    return json.loads(content).get("features", []), elapsed


# ---------------------------------------------------------------------------
# Linear scorer (Layer 2)
# ---------------------------------------------------------------------------

def encode(feat: dict, n_articles: int, n_connections: int, n_events: int) -> list[float]:
    """Map a feature dict + hard signals to a normalized [0,1] vector."""
    raw = [
        SCOPE_ORD.get(feat.get("scope", ""), 2),
        DEV_TYPE_ORD.get(feat.get("development_type", ""), 2),
        min(max(float(feat.get("affected_population_log_order", 5)), 1.0), 9.0),
        URGENCY_ORD.get(feat.get("temporal_urgency", ""), 2),
        ARC_ORD.get(feat.get("narrative_arc", ""), 2),
        STRUCT_SIG_ORD.get(feat.get("structural_significance", ""), 1),
        1 if feat.get("contrarian_potential") else 0,
        SOURCE_DIV_ORD.get(feat.get("source_diversity", ""), 2),
        DATA_AVAIL_ORD.get(feat.get("data_availability", ""), 2),
        min(n_articles, 20),
        min(n_connections, 10),
        min(n_events, 10),
    ]
    return [
        (v - lo) / (hi - lo) if hi > lo else 0.0
        for v, (lo, hi) in zip(raw, FEATURE_RANGES)
    ]


def score_item(weights: list[float], features: list[float]) -> float:
    """Dot product → sigmoid → [0, 100]. Sigmoid centered at 0.5 so average input → 50."""
    dot = sum(w * f for w, f in zip(weights, features))
    return 100.0 * (1.0 / (1.0 + math.exp(-8.0 * (dot - 0.5))))


def sgd_update(
    weights: list[float],
    features: list[float],
    current_score: float,
    direction: str,
    lr: float = 0.08,
) -> list[float]:
    """One gradient step. Target: 80 for upvote, 20 for downvote."""
    target = 80.0 if direction == "up" else 20.0
    error = (target - current_score) / 100.0
    return [w + lr * error * f for w, f in zip(weights, features)]


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

def print_ranked(items: list[dict], kind: str) -> None:
    ranked = sorted(items, key=lambda x: x.get("score") or 0, reverse=True)
    print(f"\n{'='*65}")
    print(f"  {kind.upper()}S — ranked by score")
    print(f"{'='*65}\n")
    for item in ranked:
        score = item.get("score")
        score_str = f"{score:>5.1f}" if score is not None else "  n/a"
        bar = "█" * int((score or 0) // 10)
        print(f"[{score_str}] {bar:<10}  {item['title']}")
        feat = item.get("features") or {}
        if feat:
            tags = ", ".join(feat.get("topic_tags", []))
            angle = feat.get("one_line_angle", "")
            if tags:
                print(f"           tags: {tags}")
            if angle and angle != "No clear differentiated angle.":
                print(f"           angle: {angle}")
        print()


# ---------------------------------------------------------------------------
# Main flows
# ---------------------------------------------------------------------------

def do_score(db_path: Path, force: bool) -> None:
    run_ts, events, trends = load_latest_run(db_path)
    print(f"Run {run_ts}: {len(events)} events, {len(trends)} trends")

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY environment variable not set")
    client = OpenAI(base_url=OPENROUTER_BASE, api_key=api_key)
    weights = load_weights(db_path)

    for kind, items, table in [("event", events, "events"), ("trend", trends, "trends")]:
        need_extraction = [it for it in items if force or it["features"] is None]
        if need_extraction:
            print(f"\nExtracting features for {len(need_extraction)} {kind}s via {MODEL} …")
            feat_list, elapsed = call_features(client, need_extraction, kind)
            print(f"  ({elapsed:.1f}s)")
            feat_by_id = {f["id"]: f for f in feat_list}
            for item in need_extraction:
                feat = feat_by_id.get(item["id"])
                if feat:
                    item["features"] = feat
                    save_features(db_path, run_ts, item["id"], table, feat)
        else:
            print(f"  {kind}s: using cached features")

        for item in items:
            feat = item.get("features") or {}
            n_articles = len(item.get("article_ids", []))
            n_connections = len((feat.get("connects_to_ongoing") or []))
            n_events = len(item.get("event_ids", []))
            vec = encode(feat, n_articles, n_connections, n_events)
            item["score"] = score_item(weights, vec)
            save_score(db_path, run_ts, item["id"], table, item["score"])

    print_ranked(trends, "trend")
    print_ranked(events, "event")


def do_feedback(db_path: Path, item_type: str, item_id: str, direction: str) -> None:
    run_ts, events, trends = load_latest_run(db_path)
    items = events if item_type == "event" else trends
    item = next((it for it in items if it["id"] == item_id), None)
    if not item:
        print(f"Error: {item_type} '{item_id}' not found in latest run.", file=sys.stderr)
        sys.exit(1)

    weights = load_weights(db_path)
    feat = item.get("features") or {}
    n_articles = len(item.get("article_ids", []))
    n_connections = len((feat.get("connects_to_ongoing") or []))
    n_events = len(item.get("event_ids", []))
    vec = encode(feat, n_articles, n_connections, n_events)
    current_score = score_item(weights, vec)

    new_weights = sgd_update(weights, vec, current_score, direction)
    save_weights(db_path, new_weights)
    log_feedback(db_path, run_ts, item_type, item_id, direction)

    new_score = score_item(new_weights, vec)
    print(f"Feedback recorded: {item_type} '{item_id}' {direction}")
    print(f"  Score: {current_score:.1f} → {new_score:.1f}")

    delta = {name: round(new_weights[i] - weights[i], 4) for i, name in enumerate(FEATURE_NAMES) if abs(new_weights[i] - weights[i]) > 0.001}
    if delta:
        print(f"  Weight deltas: {delta}")


def main() -> None:
    db_path = DB_PATH

    if len(sys.argv) >= 2 and sys.argv[1] == "feedback":
        if len(sys.argv) != 5:
            print("Usage: score_digest.py feedback <event|trend> <id> <up|down>", file=sys.stderr)
            sys.exit(1)
        _, _, item_type, item_id, direction = sys.argv
        if item_type not in ("event", "trend") or direction not in ("up", "down"):
            print("item_type must be 'event' or 'trend'; direction must be 'up' or 'down'", file=sys.stderr)
            sys.exit(1)
        if not db_path.exists():
            print(f"Error: '{db_path}' not found.", file=sys.stderr)
            sys.exit(1)
        init_db(db_path)
        do_feedback(db_path, item_type, item_id, direction)
    else:
        force = "--force" in sys.argv
        if not db_path.exists():
            print(f"Error: '{db_path}' not found. Run digest_articles.py first.", file=sys.stderr)
            sys.exit(1)
        init_db(db_path)
        do_score(db_path, force)


if __name__ == "__main__":
    main()
