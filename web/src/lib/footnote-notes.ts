import type { HastNode } from "$lib/markdown-plugins";

export type FootnoteDefinitions = Record<string, HastNode[]>;

export interface FootnoteNote {
  id: string;
  content: HastNode;
}

export interface FootnotePresentation {
  definitions: FootnoteDefinitions;
  notes: FootnoteNote[];
}

function footnoteTarget(node: HastNode): string | null {
  const href = node.properties?.href;
  if (typeof href !== "string" || !href.startsWith("#")) return null;
  const target = href.slice(1);
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function withoutFootnoteBackrefs(node: HastNode): HastNode | null {
  if (node.tagName === "a" && node.properties?.dataFootnoteBackref != null) {
    return null;
  }
  return {
    ...node,
    properties: node.properties ? { ...node.properties } : undefined,
    children: node.children
      ?.map(withoutFootnoteBackrefs)
      .filter((child): child is HastNode => child !== null),
  };
}

function collectDefinitions(root: HastNode): Record<string, HastNode[]> {
  const definitions: Record<string, HastNode[]> = {};
  const walk = (node: HastNode, insideFootnotes: boolean): void => {
    const inFootnoteSection = insideFootnotes || node.properties?.dataFootnotes != null;
    const id = node.properties?.id;
    if (inFootnoteSection && node.tagName === "li" && typeof id === "string") {
      definitions[id] = (node.children ?? [])
        .map(withoutFootnoteBackrefs)
        .filter((child): child is HastNode => child !== null);
    }
    node.children?.forEach((child) => walk(child, inFootnoteSection));
  };
  walk(root, false);
  return definitions;
}

/**
 * Resolve footnote references against definitions owned by each parsed HAST
 * root. Unresolved references are deliberately left unannotated so partial
 * streaming markdown renders them as ordinary links/text.
 */
export function buildFootnotePresentation(
  roots: readonly HastNode[],
  idPrefix: string,
): FootnotePresentation {
  const definitions: FootnoteDefinitions = {};
  const notes: FootnoteNote[] = [];
  let index = 0;

  for (const root of roots) {
    const rootDefinitions = collectDefinitions(root);
    const walk = (node: HastNode): void => {
      if (node.tagName === "a" && node.properties?.dataFootnoteRef === true) {
        const target = footnoteTarget(node);
        const content = target ? rootDefinitions[target] : undefined;
        if (content) {
          const id = `${idPrefix}-${index++}`;
          node.properties.dataMarginNoteId = id;
          definitions[id] = content;
          notes.push({
            id,
            content: { type: "root", children: content },
          });
        } else {
          delete node.properties.dataMarginNoteId;
        }
      }
      node.children?.forEach(walk);
    };
    walk(root);
  }

  return { definitions, notes };
}
