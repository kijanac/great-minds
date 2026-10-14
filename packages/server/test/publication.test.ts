import type {
  OriginSessionDetail,
  SessionExchangeEvent,
  SessionResponse,
} from "@great-minds/domain";
import { Effect, Result } from "effect";
import { parseOfficeAsync } from "officeparser";
import { describe, expect, it } from "vitest";

import { publicationExchanges } from "../src/conversation-history/presentation.ts";
import { compilePublication, prepareSessionPublication } from "../src/publication/markdown.ts";
import { makePdfRenderer } from "../src/publication/pdf.ts";
import { sessionId, uuid, vaultId } from "./fixtures/conversation-history.ts";

const links = { webUrl: new URL("https://research.example"), vaultId };
const exchange = (
  index: number,
  answer: string,
  status: SessionExchangeEvent["status"] = "completed",
): SessionExchangeEvent => ({
  type: "exchange",
  exId: uuid(index),
  reply_id: uuid(index + 100),
  version: 1,
  status,
  error: null,
  query: `Question ${index}`,
  answer,
  thinking: [],
  ts: new Date("2026-01-01"),
});
const session = (
  events: readonly SessionExchangeEvent[],
  threads: readonly OriginSessionDetail[] = [],
): SessionResponse => ({
  id: sessionId,
  kind: "session",
  activity: null,
  events,
  origin_title: null,
  threads,
});
const origin = {
  kind: "answer",
  session_id: sessionId,
  exchange_id: uuid(1),
  anchor: "SELECTED_PASSAGE",
  paragraph: "RECORDED_PARAGRAPH",
  paragraph_index: 0,
} as const;
const note = (): Extract<OriginSessionDetail, { availability: "available" }> => ({
  availability: "available",
  activity: null,
  session: {
    id: sessionId,
    kind: "session",
    query: "Continued note",
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    user_id: uuid(2),
    origin,
    origin_title: null,
  },
  events: [
    {
      type: "meta",
      id: sessionId,
      query: "Continued note",
      ts: new Date("2026-01-01"),
      user_id: uuid(2),
      origin,
    },
    exchange(3, "ATTACHED_NOTE[^1]\n\n[^1]: NOTE_CITATION"),
  ],
});

describe("conversation publication", () => {
  it("includes saved private partials and continued notes without widening public selection", async () => {
    const root = session(
      [exchange(1, "STOPPED_PROSE", "stopped"), exchange(2, "PRIVATE_PARTIAL", "failed")],
      [note()],
    );
    const publication = await Effect.runPromise(prepareSessionPublication(root, links));
    for (const value of [
      "STOPPED_PROSE",
      "PRIVATE_PARTIAL",
      "ATTACHED_NOTE",
      "RECORDED_PARAGRAPH",
      "SELECTED_PASSAGE",
      "NOTE_CITATION",
    ])
      expect(publication.markdown).toContain(value.replaceAll("_", "\\_"));
    expect(publication.markdown).not.toMatch(/Response (stopped|failed|in progress)/u);
    const shared = compilePublication(
      [{ exchanges: publicationExchanges(root.events), origin: null }],
      links,
    ).markdown;
    expect(shared).toContain("STOPPED\\_PROSE");
    expect(shared).not.toMatch(/PRIVATE|ATTACHED|RECORDED|SELECTED/u);
  });

  it("refuses active roots, saving children, and unreadable required notes", async () => {
    const child = note();
    const inputs = [
      {
        ...session([exchange(1, "partial", "running")]),
        activity: { reply_id: uuid(101), status: "running" as const },
      },
      session(
        [exchange(1, "saved")],
        [{ ...child, activity: { reply_id: uuid(103), status: "settling" } }],
      ),
      session(
        [exchange(1, "saved")],
        [{ availability: "unavailable", session: child.session, detail: "unreadable" }],
      ),
    ];
    const tags: string[] = [];
    for (const input of inputs) {
      const result = await Effect.runPromise(
        Effect.result(prepareSessionPublication(input, links)),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) tags.push(result.failure._tag);
    }
    expect(tags).toEqual(["Conflict", "Conflict", "ServiceUnavailable"]);
  });

  it("scopes citations and heading links and gives vault citations real absolute destinations", () => {
    const body =
      "## Evidence\n\nClaim[^1] and repeat[^1]. [Heading](#evidence). [Source][source].\n\n[^1]: CITATION\n\n[source]: raw/source.md#%5Ep7";
    const publication = compilePublication(
      [
        {
          origin: null,
          exchanges: [exchange(1, body), exchange(2, body.replace("CITATION", "SECOND"))],
        },
      ],
      links,
    );
    expect(publication.markdown.match(/\[\^q1-1\]/gu)).toHaveLength(3);
    expect(publication.markdown.match(/\[\^q2-1\]/gu)).toHaveLength(3);
    expect(publication.markdown).toContain("[Heading](#evidence)");
    expect(publication.markdown).toContain("[Heading](#evidence-1)");
    expect(publication.markdown).toContain(
      `https://research.example/doc/raw/source.md?vault=${vaultId}#%5Ep7`,
    );
    expect(publication.markdown).toContain("Great Minds access required");
    expect(publication.markdown).toContain("[Source][q2-source]");
  });

  it("renders representative Markdown as tagged PDF and rejects missing glyphs", async () => {
    const renderer = await Effect.runPromise(makePdfRenderer(process.env.TYPST_BINARY ?? "typst"));
    const body =
      '## Evidence\n\nPROSEMARKER 💡\n\n**Strong**, *emphasis*, ~~deleted~~, `inline` and a citation.[^1]\n\n[^1]: FIRST_CITATION [source](https://example.org)\n\n> A quotation.\n\n- [x] LISTMARKER Done\n- [ ] Open\n\n1. First\n2. Second\n\n| Claim | Evidence |\n| --- | --- |\n| **TABLEMARKER Rich cell** | [source][ref] |\n\n[ref]: https://example.org/evidence\n\n![Image description](https://example.org/image.png)\n\n```js\nconst answer = 42;\n```\n\nLiteral #panic("injected") and <script>text</script>.\n\nÉléments Ελληνικά Русский 中文 العربية.\n\n---\n\nEnd.';
    const publication = compilePublication(
      [
        {
          origin: null,
          exchanges: [exchange(1, body), exchange(2, "Second[^1]\n\n[^1]: SECOND_CITATION")],
        },
      ],
      links,
    );
    const bytes = await Effect.runPromise(
      renderer.render(publication, "a4", new Date("2026-01-01")),
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(new TextDecoder().decode(bytes.subarray(-20))).toContain("%%EOF");
    const text = await parseOfficeAsync(Buffer.from(bytes), { outputErrorToConsole: false });
    for (const marker of [
      "PROSEMARKER",
      "LISTMARKER",
      "TABLEMARKER",
      "FIRST_CITATION",
      "SECOND_CITATION",
      "💡",
    ])
      expect(text).toContain(marker);
    const unsupported = compilePublication(
      [{ origin: null, exchanges: [exchange(1, "မြန်မာစာ")] }],
      links,
    );
    const result = await Effect.runPromise(
      Effect.result(renderer.render(unsupported, "a4", new Date("2026-01-01"))),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ServiceUnavailable" } });
    expect(unsupported.markdown).toContain("မြန်မာစာ");
  });
});
