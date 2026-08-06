import { z } from 'zod';

import { fileChangeSchema, runtimeStatusSchema } from './domain';

const configurationChangedSchema = z.object({
    source: z.string(),
    error: z.string().optional(),
});

/** Every payload the Runtime may push to Main and the Renderer, keyed by its wire event name. */
export const runtimeEventPayloads = {
    'runtime.status': z.object({
        status: runtimeStatusSchema.exclude(['starting']),
        restartCount: z.number(),
    }),
    'state.changed': z.object({ reason: z.string() }),
    'terminal.output': z.object({
        terminalId: z.string(),
        data: z.string(),
        droppedBytes: z.number().optional(),
    }),
    'terminal.exit': z.object({
        terminalId: z.string(),
        exitCode: z.number(),
        signal: z.number().optional(),
    }),
    'files.changed': z.object({
        sessionId: z.string(),
        changes: z.array(fileChangeSchema),
        overflow: z.boolean(),
    }),
    'settings.changed': configurationChangedSchema,
    'keybindings.changed': configurationChangedSchema,
    'theme.changed': configurationChangedSchema,
    'command.execute': z.object({ command: z.string() }),
} as const;

type CaxriEventName = keyof typeof runtimeEventPayloads;

type RuntimeEventPayload<E extends CaxriEventName> = z.infer<(typeof runtimeEventPayloads)[E]>;

/** Discriminated union so `onEvent` listeners narrow `payload` from `event` alone. */
export type RuntimeEvent = {
    [E in CaxriEventName]: { event: E; payload: RuntimeEventPayload<E> };
}[CaxriEventName];

/** Per-event `{ event, payload }` schema, keyed the same way as `runtimeEventPayloads`. */
type RuntimeEventSchemaMap = {
    [E in CaxriEventName]: z.ZodObject<{
        event: z.ZodLiteral<E>;
        payload: (typeof runtimeEventPayloads)[E];
    }>;
};

/**
 * `runtimeEventSchema` is derived from `runtimeEventPayloads` instead of listing the event names
 * a second time, so a new entry only needs to be added once (to `runtimeEventPayloads`) to be
 * both a valid payload and a validated member of the discriminated union. `Object.keys`/`.map`
 * can't distribute a generic per array element, so the per-event schema map is built once and
 * cast to `RuntimeEventSchemaMap` (itself derived from `CaxriEventName`, not a hand-listed union)
 * to restore the precise per-event literal types that `z.discriminatedUnion` needs for narrowing.
 */
const runtimeEventSchemas = Object.fromEntries(
    (Object.keys(runtimeEventPayloads) as CaxriEventName[]).map((event) => [
        event,
        z.object({ event: z.literal(event), payload: runtimeEventPayloads[event] }),
    ]),
) as RuntimeEventSchemaMap;

const runtimeEventSchemaList = Object.values(runtimeEventSchemas) as [
    RuntimeEventSchemaMap[CaxriEventName],
    ...RuntimeEventSchemaMap[CaxriEventName][],
];

export const runtimeEventSchema = z.discriminatedUnion('event', runtimeEventSchemaList);
