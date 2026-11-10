import {
  Conflict,
  ServiceUnavailable,
  type SessionExchangeEvent,
  type SessionOrigin,
  type SessionResponse,
  type Uuid,
} from "@great-minds/domain";
import { Effect } from "effect";
import GithubSlugger from "github-slugger";
import type { Heading, Paragraph, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

export interface PublicationSection {
  readonly exchanges: readonly SessionExchangeEvent[];
  readonly origin: SessionOrigin | null;
}

export interface PublicationLinks {
  readonly webUrl: URL;
  readonly vaultId: Uuid;
}

export interface Publication {
  readonly title: string;
  readonly tree: Root;
  readonly markdown: string;
}

const markdown = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: "-",
    fences: true,
    handlers: {
      html: (node) =>
        node.value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    },
  });
const heading = (depth: Heading["depth"], value: string): Heading => ({
  type: "heading",
  depth,
  children: [{ type: "text", value }],
});
const paragraph = (value: string): Paragraph => ({
  type: "paragraph",
  children: [{ type: "text", value }],
});

export const publicationLink = (value: string, links: PublicationLinks): string => {
  if (value.startsWith("#")) return value;
  if (/^(https?:|mailto:)/iu.test(value)) {
    const url = URL.parse(value);
    return url?.href ?? "";
  }
  if (!/^(raw|wiki)\//u.test(value)) return "";
  const url = new URL(`/doc/${value}`, links.webUrl);
  url.searchParams.set("vault", links.vaultId);
  return url.href;
};

export const compilePublication = (
  sections: readonly PublicationSection[],
  links: PublicationLinks,
): Publication => {
  const tree: Root = { type: "root", children: [] };
  const slugger = new GithubSlugger();
  const title = sections[0]?.exchanges[0]?.query || "Conversation";
  let questionNumber = 0;
  let privateLinks = false;
  const addHeading = (node: Heading) => {
    const id = slugger.slug(toString(node));
    node.data = { hProperties: { id } };
    return id;
  };
  const pushHeading = (depth: Heading["depth"], value: string) => {
    const node = heading(depth, value);
    addHeading(node);
    tree.children.push(node);
  };

  for (const [sectionIndex, section] of sections.entries()) {
    if (sectionIndex === 1) pushHeading(2, "Attached notes");
    for (const [index, exchange] of section.exchanges.entries()) {
      const depth = sectionIndex > 0 ? 3 : index === 0 ? 1 : 2;
      pushHeading(depth, exchange.query);
      if (index === 0 && section.origin !== null) {
        const origin = section.origin;
        if (origin.paragraph !== null)
          tree.children.push({ type: "blockquote", children: [paragraph(origin.paragraph)] });
        if (origin.anchor !== null && origin.anchor !== origin.paragraph)
          tree.children.push(paragraph(`Selected passage: ${origin.anchor}`));
      }
      const answer = markdown.parse(exchange.answer);
      const scope = `q${++questionNumber}`;
      const localSlugger = new GithubSlugger();
      const headings = new Map<string, string>();
      let shallowest = 6;
      visit(answer, "heading", (node) => {
        shallowest = Math.min(shallowest, node.depth);
      });
      let precedingDepth: number = depth;
      visit(answer, (node) => {
        delete node.position;
        if (node.type === "heading") {
          const localId = localSlugger.slug(toString(node));
          const levels: readonly Heading["depth"][] = [1, 2, 3, 4, 5, 6];
          node.depth = levels[Math.min(5, depth + node.depth - shallowest, precedingDepth)] ?? 6;
          precedingDepth = node.depth;
          headings.set(localId, addHeading(node));
        }
        if (
          node.type === "footnoteDefinition" ||
          node.type === "footnoteReference" ||
          node.type === "definition" ||
          node.type === "linkReference" ||
          node.type === "imageReference"
        ) {
          node.identifier = `${scope}-${node.identifier}`;
          node.label = node.identifier;
        }
        if (node.type === "table") {
          const columns = node.children.reduce(
            (count, row) => Math.max(count, row.children.length),
            0,
          );
          node.align = Array.from({ length: columns }, (_, index) => node.align?.[index] ?? null);
          for (const row of node.children)
            while (row.children.length < columns)
              row.children.push({ type: "tableCell", children: [] });
        }
      });
      visit(answer, (node) => {
        if (node.type !== "link" && node.type !== "definition" && node.type !== "image") return;
        if (node.url.startsWith("#")) {
          const localId = URL.parse(node.url, "https://publication.invalid/")?.hash.slice(1);
          let decoded = localId;
          try {
            decoded = localId === undefined ? undefined : decodeURIComponent(localId);
          } catch {
            decoded = undefined;
          }
          const target = decoded === undefined ? undefined : headings.get(decoded);
          node.url = target === undefined ? "" : `#${target}`;
        } else {
          const original = node.url;
          node.url = publicationLink(original, links);
          if (/^(raw|wiki)\//u.test(original)) {
            node.title = "Great Minds access required";
            privateLinks = true;
          }
        }
      });
      tree.children.push(...answer.children);
    }
  }
  if (privateLinks)
    tree.children.push(paragraph("Links to Great Minds require access to the original vault."));
  return { title, tree, markdown: markdown.stringify(tree) };
};

export const prepareSessionPublication = (session: SessionResponse, links: PublicationLinks) =>
  Effect.gen(function* () {
    const sections: PublicationSection[] = [];
    const root = session.events.find((event) => event.type === "meta");
    if (
      session.activity !== null ||
      session.events.some((event) => event.type === "exchange" && event.status === "running")
    ) {
      return yield* new Conflict({
        detail: "Wait for the conversation to finish saving before exporting.",
      });
    }
    sections.push({
      exchanges: session.events.filter((event) => event.type === "exchange"),
      origin: root?.origin ?? null,
    });
    for (const thread of session.threads) {
      if (thread.availability === "unavailable")
        return yield* new ServiceUnavailable({
          detail:
            "An attached note could not be loaded. Reload the conversation and try exporting again.",
        });
      if (
        thread.activity !== null ||
        thread.events.some((event) => event.type === "exchange" && event.status === "running")
      ) {
        return yield* new Conflict({
          detail: "Wait for attached notes to finish saving before exporting.",
        });
      }
      sections.push({
        exchanges: thread.events.filter((event) => event.type === "exchange"),
        origin: thread.events.find((event) => event.type === "meta")?.origin ?? null,
      });
    }
    return compilePublication(sections, links);
  });
