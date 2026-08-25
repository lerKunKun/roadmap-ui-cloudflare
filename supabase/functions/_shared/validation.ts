import { z } from "zod"

export const suggestionSchema = z
  .object({
    projectId: z.uuid(),
    title: z.string().trim().min(2).max(120),
    description: z.string().trim().max(4000),
  })
  .strict()

export const voteSchema = z
  .object({
    roadmapItemId: z.uuid(),
  })
  .strict()
