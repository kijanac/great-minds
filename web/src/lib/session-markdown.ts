import { loadSessionMarkdown } from "@/api/sessions";
import type { Exchange } from "@/lib/types";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Download the server-rendered `sessions/{id}.md` as a file. */
export async function downloadSessionMarkdown(
  sessionId: string,
  thread: Exchange[],
): Promise<void> {
  const markdown = await loadSessionMarkdown(sessionId);
  const slug = thread.length > 0 ? slugify(thread[0].query) : "";
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slug || "session"}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}
