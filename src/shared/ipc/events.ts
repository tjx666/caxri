import { z } from 'zod';

import { configurationSourceSchema } from '../configuration-contract';

import {
    agentHookHealthMapSchema,
    fileChangeSchema,
    fileMutationOperationSchema,
    identifierSchema,
    runtimeStatusSchema,
    updateStateSchema,
} from './domain';

const configurationChangedSchema = z.object({
    source: configurationSourceSchema,
    error: z.string().optional(),
});

const fullStateChangeReasonSchema = z.enum([
    'project.create',
    'project.delete',
    'project.reorder',
    'session.create',
    'session.select',
    'session.archive',
    'session.unarchive',
    'session.delete',
    'terminal.create',
    'terminal.close',
    'unknown',
]);

const stateChangedPayloadSchema = z.preprocess(
    (value) => {
        if (
            typeof value === 'object' &&
            value !== null &&
            'kind' in value &&
            (value.kind === 'full' || value.kind === 'records')
        ) {
            return value;
        }
        /** Future event scopes must converge safely until this client knows how to patch them. */
        return { kind: 'full', reason: 'unknown' };
    },
    z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('full'), reason: fullStateChangeReasonSchema }),
        z.object({
            kind: z.literal('records'),
            sessionIds: z.array(identifierSchema).max(64).default([]),
            terminalIds: z.array(identifierSchema).max(64).default([]),
        }),
    ]),
);

/** Every payload the Runtime may push to Main and the Renderer, keyed by its wire event name. */
export const runtimeEventPayloads = {
    'runtime.status': z.object({
        status: runtimeStatusSchema.exclude(['starting']),
        restartCount: z.number(),
    }),
    'state.changed': stateChangedPayloadSchema,
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
        gitIgnoreRulesChanged: z.literal(true).optional(),
    }),
    'files.operationChanged': fileMutationOperationSchema,
    'settings.changed': configurationChangedSchema,
    'agentHooks.changed': agentHookHealthMapSchema,
    'keybindings.changed': configurationChangedSchema,
    'theme.changed': configurationChangedSchema,
    'updates.state': updateStateSchema,
    'window.fullScreen': z.object({ isFullScreen: z.boolean() }),
    /**
     * `viaAccelerator` distinguishes a native menu item fired by its keyboard accelerator from one
     * fired by an actual mouse/touch click, so the Renderer can apply the editable-focus shortcut
     * policy only to the accelerator path (see `commands/execute.ts#runCommand`).
     */
    'command.execute': z.object({ command: z.string(), viaAccelerator: z.boolean().optional() }),
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
