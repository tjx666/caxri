import { z } from 'zod';

const terminalIdSchema = z.string().min(1).max(200);
const workItemPathSchema = z.string().min(1).max(16_384);

export const workItemSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('terminal'), terminalId: terminalIdSchema }),
    z.object({ kind: z.literal('editor'), path: workItemPathSchema }),
]);

/** Browser-safe center-pane identity shared by persistence and every transport adapter. */
export type WorkItem = z.infer<typeof workItemSchema>;
