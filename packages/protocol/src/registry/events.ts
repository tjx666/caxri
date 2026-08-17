import { z } from 'zod';

import { agentDispatchReceiptSchema } from '../agent/agent-dispatch-contract.js';
import { agentEndpointSummarySchema } from '../agent/agent-endpoint-contract.js';
import {
    agentHeldMessageSchema,
    agentMessageReceiptSchema,
} from '../agent/agent-inbox-contract.js';
import { configurationSourceSchema as configSourceSchema } from '../configuration/configuration-contract.js';
import { commandIdSchema } from '../domain/commands.js';
import {
    agentHookHealthMapSchema,
    fileChangeSchema,
    fileMutationOperationSchema,
    identifierSchema,
    pathSchema,
    runtimeStatusSchema,
    updateStateSchema,
} from '../domain/domain.js';

const configChangedSchema = z.object({
    source: configSourceSchema,
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
    'session.workbenchRoot',
    'terminal.create',
    'terminal.close',
    'terminal.moveToNewSession',
    'unknown',
]);

const stateChangeRecordIdsSchema = z.array(identifierSchema).max(64).default([]);

const stateChangedShapeSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('full'), reason: fullStateChangeReasonSchema }),
    z.object({
        kind: z.literal('records'),
        sessionIds: stateChangeRecordIdsSchema,
        terminalIds: stateChangeRecordIdsSchema,
    }),
]);

function normalizeStateChangedPayload(value: unknown): unknown {
    if (
        typeof value === 'object' &&
        value !== null &&
        'kind' in value &&
        (value.kind === 'full' || value.kind === 'records')
    ) {
        return value;
    }
    /**
     * Future event scopes must converge safely until this client knows how to patch them.
     */
    return { kind: 'full', reason: 'unknown' };
}

const stateChangedPayloadSchema = z.preprocess(
    normalizeStateChangedPayload,
    stateChangedShapeSchema,
);

/**
 * Every payload the Runtime may push to Main and the Renderer, keyed by its wire event name.
 */
export const runtimeEventPayloads = {
    'runtime.status': z.object({
        status: runtimeStatusSchema.exclude(['starting']),
        restartCount: z.number(),
    }),
    'state.changed': stateChangedPayloadSchema,
    'terminal.output': z.object({
        terminalId: identifierSchema,
        data: z.string(),
        droppedBytes: z.number().optional(),
    }),
    'terminal.exit': z.object({
        terminalId: identifierSchema,
        exitCode: z.number(),
        signal: z.number().optional(),
    }),
    'files.changed': z.object({
        sessionId: identifierSchema,
        /**
         * Stable Project scope lets inactive Sessions sharing this root converge their caches.
         */
        workbenchProjectId: identifierSchema,
        changes: z.array(fileChangeSchema),
        overflow: z.boolean(),
        gitIgnoreRulesChanged: z.literal(true).optional(),
    }),
    'files.operationChanged': fileMutationOperationSchema,
    /**
     * Repository-identity invalidation signal: every Session whose Git projection includes one of the listed
     * repositories must refetch. Payload carries opaque repository ids only — never a `.git` path or repository
     * content.
     */
    'git.changed': z.object({
        sessionIds: z.array(identifierSchema).max(1_024),
        repositoryIds: z.array(identifierSchema).max(256),
        scope: z.enum(['status', 'topology']),
    }),
    /**
     * One-shot, content-free prompt trigger; Git topology remains Runtime-owned.
     */
    'workbench.candidate': z.object({
        candidateId: identifierSchema,
        sessionId: identifierSchema,
    }),
    /**
     * One-shot UI coordination layered over the durable `state.changed` convergence event.
     */
    'workbench.changed': z.object({
        sessionId: identifierSchema,
        workbenchProjectId: identifierSchema,
        reason: z.enum(['selected', 'authorized', 'fallback']),
        returnedProjectTitle: z.string().min(1).max(1_024).optional(),
    }),
    'settings.changed': configChangedSchema,
    'agentHooks.changed': agentHookHealthMapSchema,
    /**
     * Sender-only status metadata. The message body is deliberately not representable here.
     */
    'agent.message.receipt': agentMessageReceiptSchema,
    /**
     * Desktop-only approval projection with a bounded, inert plain-text preview.
     */
    'agent.message.held': agentHeldMessageSchema,
    /**
     * Volatile generation health; clients refresh `agent.list` for the current peer set.
     */
    'agent.messaging.changed': agentEndpointSummarySchema,
    /**
     * Durable, body-free lifecycle evidence for an explicit Agent dispatch.
     */
    'agent.dispatch.changed': agentDispatchReceiptSchema,
    'keybindings.changed': configChangedSchema,
    'theme.changed': configChangedSchema,
    'updates.state': updateStateSchema,
    'window.fullScreen': z.object({ isFullScreen: z.boolean() }),
    'desktop.openRequested': z.object({
        sessionId: identifierSchema,
        kind: z.enum(['file', 'directory']),
        path: pathSchema.optional(),
    }),
    /**
     * `viaAccelerator` distinguishes a native menu item fired by its keyboard accelerator from one fired by an actual
     * mouse/touch click, so the Renderer can apply the editable-focus shortcut policy only to the accelerator path (see
     * `commands/execute.ts#runCommand`).
     */
    'command.execute': z.object({
        command: commandIdSchema,
        viaAccelerator: z.boolean().optional(),
    }),
} as const;

type CaxriEventName = keyof typeof runtimeEventPayloads;

type RuntimeEventPayload<E extends CaxriEventName> = z.infer<(typeof runtimeEventPayloads)[E]>;

/**
 * Discriminated union so `onEvent` listeners narrow `payload` from `event` alone.
 */
export type RuntimeEvent = {
    [E in CaxriEventName]: { event: E; payload: RuntimeEventPayload<E> };
}[CaxriEventName];

/**
 * Per-event `{ event, payload }` schema, keyed the same way as `runtimeEventPayloads`.
 */
type RuntimeEventSchemaMap = {
    [E in CaxriEventName]: z.ZodObject<{
        event: z.ZodLiteral<E>;
        payload: (typeof runtimeEventPayloads)[E];
    }>;
};

/**
 * `runtimeEventSchema` is derived from `runtimeEventPayloads` instead of listing the event names a second time, so a
 * new entry only needs to be added once (to `runtimeEventPayloads`) to be both a valid payload and a validated member
 * of the discriminated union. `Object.keys`/`.map` can't distribute a generic per array element, so the per-event
 * schema map is built once and cast to `RuntimeEventSchemaMap` (itself derived from `CaxriEventName`, not a hand-listed
 * union) to restore the precise per-event literal types that `z.discriminatedUnion` needs for narrowing.
 */
const runtimeEventSchemas = Object.fromEntries(
    (Object.keys(runtimeEventPayloads) as CaxriEventName[]).map((event) => [
        event,
        z.object({ event: z.literal(event), payload: runtimeEventPayloads[event] }),
    ]),
) as RuntimeEventSchemaMap;

const runtimeEventSchemaList = Object.values(runtimeEventSchemas) as [
    RuntimeEventSchemaMap[CaxriEventName],
    ...Array<RuntimeEventSchemaMap[CaxriEventName]>,
];

export const runtimeEventSchema = z.discriminatedUnion('event', runtimeEventSchemaList);
