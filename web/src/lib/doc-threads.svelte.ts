import { listSessionsByOrigin, type OriginScope } from "#lib/api/sessions.ts";
import { Conversation } from "#lib/conversation.svelte.ts";
import { passageMark, revealPassage } from "#lib/passage-navigation.ts";
import type { SelectionInfo } from "#lib/types.ts";
import { isAbortError } from "#lib/utils.ts";

const threadCard = (threadId: string) =>
  window.document.querySelector<HTMLElement>(`[data-btw-id="${CSS.escape(threadId)}"]`);

export class DocThreads {
  threads = $state<Conversation[]>([]);
  loading = $state(true);
  error = $state<string | null>(null);
  jumpable = $state<Set<string>>(new Set());
  expanded = $state<Set<string>>(new Set());

  #controller = new AbortController();

  constructor(
    private readonly originPath: string,
    private readonly originScope: OriginScope,
  ) {
    void this.#load();
  }

  destroy = (): void => {
    this.#controller.abort();
    for (const thread of this.threads) thread.destroy();
  };

  #load = async (): Promise<void> => {
    try {
      const details = await listSessionsByOrigin(this.originPath, this.#controller.signal);
      if (this.#controller.signal.aborted) return;
      this.threads = details.flatMap((detail) =>
        detail.session.origin?.kind === "document" ? [new Conversation({ detail })] : [],
      );
      this.refreshJumpable();
    } catch (error) {
      if (isAbortError(error) || this.#controller.signal.aborted) return;
      console.error("Failed to load doc threads:", error);
      this.error = "failed to load notes";
    } finally {
      this.loading = false;
    }
  };

  /** Re-check which anchors resolve to a rendered mark (or, for in-flight
   * drafts, a rendered thread) in the document. Threads whose quote could
   * not be located lose the jump affordance. */
  refreshJumpable = (): void => {
    const next = new Set<string>();
    for (const thread of this.threads) {
      if (!thread.anchor.quote) continue;
      if (passageMark(thread.id) !== null || (thread.draft && threadCard(thread.id) !== null))
        next.add(thread.id);
    }
    this.jumpable = next;
  };

  #findThread = (threadId: string): Conversation | undefined =>
    this.threads.find((thread) => thread.id === threadId);

  startThread = (info: SelectionInfo): void => {
    const thread = new Conversation({
      origin: {
        kind: "document",
        doc_path: this.originPath,
        origin_scope: this.originScope,
        anchor: info.quote,
        paragraph: info.context,
        section: info.section,
        occurrence: info.occurrence,
      },
    });
    this.threads = [...this.threads, thread];
    this.expanded = new Set([...this.expanded, thread.id]);
    this.refreshJumpable();
  };

  dismissEmpty = (threadId: string): void => {
    const target = this.#findThread(threadId);
    if (!target?.draft || target.exchanges.length > 0) return;
    target.destroy();
    this.threads = this.threads.filter((thread) => thread.id !== threadId);
    const next = new Set(this.expanded);
    next.delete(threadId);
    this.expanded = next;
  };

  toggleExpanded = (threadId: string): void => {
    const next = new Set(this.expanded);
    if (next.has(threadId)) next.delete(threadId);
    else next.add(threadId);
    this.expanded = next;
  };

  /** Expand a thread and scroll its anchor mark into view (chip "jump").
   * Drafts have no mark yet — fall back to scrolling their block (the
   * painted highlight). */
  jumpTo = (threadId: string): void => {
    const target = this.#findThread(threadId);
    if (!target) return;
    this.expanded = new Set([...this.expanded, threadId]);
    requestAnimationFrame(() => {
      const element = passageMark(threadId) ?? threadCard(threadId);
      if (element) revealPassage(element);
    });
  };
}
