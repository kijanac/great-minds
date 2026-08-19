<script lang="ts">
  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";

  import { resolveShare } from "$lib/api/shares";
  import AnswerBlock from "$lib/components/answer-block.svelte";
  import type { ThreadLike } from "$lib/types";

  const token = $derived(page.params.token);

  const query = createQuery(() => ({
    queryKey: ["public", "share", token],
    queryFn: () => resolveShare(token!),
    enabled: !!token,
  }));

  const share = $derived(query.data?.status === "ok" ? query.data.share : null);
  const title = $derived(
    share?.title ??
      (share?.subject_kind === "session"
        ? "Shared session"
        : "Shared reference"),
  );
  const createdLabel = $derived(
    share
      ? new Date(share.created_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "",
  );
  // Read-only annotation threads (same anchors + collapsed panels as the
  // reader, no reply box / open-session affordance).
  const threads = $derived<ThreadLike[]>(
    share?.subject_kind === "reference"
      ? share.annotations.map((annotation, index) => ({
          id: `ann:${index}`,
          sessionId: null,
          draft: false,
          anchored: true,
          anchor: {
            blockOffset: annotation.anchor.block_offset ?? -1,
            quote: annotation.anchor.quote,
            context: annotation.anchor.context ?? "",
          },
          exchanges: annotation.exchanges.map((exchange, turnIndex) => ({
            id: `ann:${index}:${turnIndex}`,
            query: exchange.query,
            thinking: [],
            answer: exchange.answer,
            btws: [],
            streaming: false,
          })),
          createdAt: annotation.created_at,
        }))
      : [],
  );

  // The share page is read-only: keep external links working but swallow
  // internal (app) navigations such as wiki/ and raw/ citations.
  function onLinkClick(event: MouseEvent) {
    const anchor =
      event.currentTarget instanceof HTMLAnchorElement
        ? event.currentTarget
        : event.target instanceof Element
          ? event.target.closest("a")
          : null;
    const href = anchor?.getAttribute("href");
    if (
      href &&
      !href.startsWith("http://") &&
      !href.startsWith("https://") &&
      !href.startsWith("#")
    ) {
      event.preventDefault();
    }
  }
</script>

<svelte:head>
  <meta name="robots" content="noindex" />
  <title>{share ? title : "Shared link"}</title>
</svelte:head>

{#if query.isLoading}
  <div class="flex min-h-screen items-center justify-center px-4">
    <p
      class="font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-ghost"
    >
      loading…
    </p>
  </div>
{:else if query.isError || query.data?.status === "gone"}
  <div
    class="flex min-h-screen flex-col items-center justify-center gap-2 px-4 text-center"
  >
    <p class="font-serif text-[length:var(--text-body)] text-warm-dim">
      This link is no longer available.
    </p>
  </div>
{:else if share}
  <article
    class="mx-auto max-w-[740px] px-4 pt-6 pb-20 select-text md:px-10 md:pt-10"
  >
    <header class="mb-10">
      <h1 class="text-[length:var(--text-title)] font-bold text-foreground">
        {title}
      </h1>
      <p
        class="mt-3 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint"
      >
        {createdLabel}
      </p>
      {#if share.subject_kind === "reference" && share.origin}
        <p
          class="mt-2 font-mono text-[length:var(--text-chrome)] tracking-[0.06em] text-warm-faint"
        >
          from {share.origin}
        </p>
      {/if}
    </header>
    <AnswerBlock
      text={share.markdown}
      exchangeId={`share:${token}`}
      btws={threads}
      streaming={false}
      variant="article"
      stripBlockRefs
      resolveBlockRefs
      marginFootnotes={false}
      readOnly
      {onLinkClick}
    />
  </article>
{/if}
