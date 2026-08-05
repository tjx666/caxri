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

export const runtimeEventSchema = z.discriminatedUnion('event', [
    z.object({
        event: z.literal('runtime.status'),
        payload: runtimeEventPayloads['runtime.status'],
    }),
    z.object({ event: z.literal('state.changed'), payload: runtimeEventPayloads['state.changed'] }),
    z.object({
        event: z.literal('terminal.output'),
        payload: runtimeEventPayloads['terminal.output'],
    }),
    z.object({ event: z.literal('terminal.exit'), payload: runtimeEventPayloads['terminal.exit'] }),
    z.object({ event: z.literal('files.changed'), payload: runtimeEventPayloads['files.changed'] }),
    z.object({
        event: z.literal('settings.changed'),
        payload: runtimeEventPayloads['settings.changed'],
    }),
    z.object({
        event: z.literal('keybindings.changed'),
        payload: runtimeEventPayloads['keybindings.changed'],
    }),
    z.object({ event: z.literal('theme.changed'), payload: runtimeEventPayloads['theme.changed'] }),
    z.object({
        event: z.literal('command.execute'),
        payload: runtimeEventPayloads['command.execute'],
    }),
]);
