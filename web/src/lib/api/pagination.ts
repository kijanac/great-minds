import type { PageInfo } from "@great-minds/domain";

export function nextPageOffset(page: {
  readonly items: readonly unknown[];
  readonly pagination: PageInfo;
}): number | undefined {
  const next = page.pagination.offset + page.items.length;
  return next < page.pagination.total ? next : undefined;
}
