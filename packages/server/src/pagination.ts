import type { PageInfo, PageParams } from "@great-minds/domain";

export type PageEnvelope<A> = {
  readonly items: readonly A[];
  readonly pagination: PageInfo;
};

export type CountRow = {
  readonly total: number;
};

export const pageEnvelope = <A>(
  items: readonly A[],
  params: PageParams,
  total: number
): PageEnvelope<A> => ({
  items,
  pagination: {
    limit: params.limit,
    offset: params.offset,
    total
  }
});

export const oneTotal = (rows: readonly CountRow[]) => {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("count query returned no rows");
  }
  return row.total;
};
