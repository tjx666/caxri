import { z } from 'zod';

/** Browser-safe center-pane identity shared by persistence and every transport adapter. */
export type WorkItem = { kind: 'terminal'; terminalId: string } | { kind: 'editor'; path: string };

const terminalIdSchema = z.string().min(1).max(200);
const workItemPathSchema = z.string().min(1).max(16_384);

export const workItemSchema: z.ZodType<WorkItem, WorkItem> = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('terminal'), terminalId: terminalIdSchema }),
    z.object({ kind: z.literal('editor'), path: workItemPathSchema }),
]);
