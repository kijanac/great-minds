import { z } from "zod";

export const OpenAIModelSchema = z
  .object({
    id: z.string(),
    object: z.literal("model"),
    created: z.number().int().nonnegative().optional(),
    owned_by: z.string().optional(),
  })
  .passthrough();

export const OpenAIModelListSchema = z.object({
  object: z.literal("list"),
  data: z.array(OpenAIModelSchema),
});

export type OpenAIModel = z.infer<typeof OpenAIModelSchema>;
export type OpenAIModelList = z.infer<typeof OpenAIModelListSchema>;
