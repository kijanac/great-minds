import { createInfiniteQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

import { createReference, listReferences } from "$lib/api/references";
import { nextPageOffset } from "$lib/api/schemas";

const PAGE_SIZE = 50;

export function useReferences() {
  const queryClient = useQueryClient();
  const references = createInfiniteQuery(() => ({
    queryKey: ["me", "refs"],
    queryFn: ({ pageParam, signal }) =>
      listReferences({ limit: PAGE_SIZE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => nextPageOffset(lastPage),
  }));
  const create = createMutation(() => ({
    mutationFn: createReference,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me", "refs"] });
    },
  }));

  return {
    create: (url: string) => create.mutateAsync(url),
    get createError() {
      return create.error instanceof Error ? create.error.message : null;
    },
    get creating() {
      return create.isPending;
    },
    get error() {
      return references.error instanceof Error ? references.error.message : null;
    },
    get items() {
      return references.data?.pages.flatMap((page) => page.items) ?? [];
    },
    get loading() {
      return references.isLoading;
    },
    get total() {
      return references.data?.pages[0]?.pagination.total ?? 0;
    },
    references,
  };
}
