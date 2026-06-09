import { z } from "zod";

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof PaginationSchema>;

export function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    pagination: z.object({
      limit: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  });
}
