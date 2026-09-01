import { createInfiniteQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

import { api, run } from "$lib/api/app";
import { errorMessage } from "$lib/api/errors";
import { nextPageOffset } from "$lib/api/pagination";

const PAGE_SIZE = 50;

export function useReferences() {
  const queryClient = useQueryClient();
  const references = createInfiniteQuery(() => ({
    queryKey: ["me", "refs"],
    queryFn: ({ pageParam }) =>
      run(api.refs.listReferences({ query: { limit: PAGE_SIZE, offset: pageParam } })),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => nextPageOffset(lastPage),
  }));
  const create = createMutation(() => ({
    mutationFn: (url: string) => run(api.refs.createReference({ payload: { url } })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me", "refs"] });
    },
  }));

  return {
    create: (url: string) => create.mutateAsync(url),
    get createError() {
      return create.error ? errorMessage(create.error) : null;
    },
    get creating() {
      return create.isPending;
    },
    get error() {
      return references.error ? errorMessage(references.error) : null;
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
