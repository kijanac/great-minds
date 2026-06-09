import { z } from "zod";

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof PaginationSchema>;

export const PaginationMetaSchema = z.object({
  limit: z.number().int().min(1).max(200),
  offset: z.number().int().min(0),
  total: z.number().int().min(0),
});

export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export function pageSchema<ItemSchema extends z.ZodType>(itemSchema: ItemSchema) {
  return z.object({
    items: z.array(itemSchema),
    pagination: PaginationMetaSchema,
  });
}
