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
    agentProviderSchema,
    fileChangeSchema,
    identifierSchema,
    pathSchema,
    runtimeStatusSchema,
    updateStateSchema,
} from '../domain/domain.js';
import { editorNavigationTargetSchema } from '../domain/editor.js';
import {
    extensionIdSchema,
    extensionViewChangeSchema,
    extensionViewEventContextSchema,
    extensionViewEventIdSchema,
    viewIdSchema,
} from '../domain/views.js';

const configChangedSchema = z.object({
    source: configSourceSchema,
    error: z.string().optional(),
});

/**
 * One watcher event must stay inside the durable protocol envelope. Producers share this bound so an in-process burst
 * cannot create an event that only fails after it reaches the recovery journal.
 */
export const MAX_FILE_CHANGES_PER_EVENT = 512;

const fullStateChangeReasonSchema = z.enum([
    'project.create',
    'project.delete',
    'project.reorder',
    'project.setIcon',
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
export const serverEventPayloads = {
    'viewContainers.catalogChanged': z.object({
        revision: z.number().int().nonnegative(),
        extensionId: extensionIdSchema.optional(),
    }),
    'viewContainers.treeChanged': z.object({
        viewId: viewIdSchema,
        eventId: extensionViewEventIdSchema,
        extensionGeneration: z.number().int().nonnegative(),
        context: extensionViewEventContextSchema,
        handles: z.array(z.string().min(1).max(512)).max(1_000).optional(),
    }),
    'viewContainers.viewChanged': z.object({
        viewId: viewIdSchema,
        eventId: extensionViewEventIdSchema,
        extensionGeneration: z.number().int().nonnegative(),
        context: extensionViewEventContextSchema,
        change: extensionViewChangeSchema,
    }),
    'runtime.status': z.object({
        status: runtimeStatusSchema.exclude(['starting']),
        restartCount: z.number(),
    }),
    'state.changed': stateChangedPayloadSchema,
    'agentTranscript.changed': z.object({ terminalId: identifierSchema }),
    'terminal.output': z.object({
        terminalId: identifierSchema,
        data: z.string(),
        droppedBytes: z.number().optional(),
    }),
    /**
     * One-shot, content-free feedback for a provider output recovery attempt.
     */
    'terminal.outputRecovery': z.object({
        terminalId: identifierSchema,
        provider: agentProviderSchema,
        status: z.enum(['recovered', 'rate-limited']),
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
        changes: z.array(fileChangeSchema).max(MAX_FILE_CHANGES_PER_EVENT),
        overflow: z.boolean(),
        gitIgnoreRulesChanged: z.literal(true).optional(),
    }),
    /**
     * Mutation invalidation deliberately omits paths and mutation input. A Renderer resolves the opaque id through the
     * Session-scoped operation API, so another selected Project never receives a foreign journal record.
     */
    'files.operationChanged': z.object({
        operationId: identifierSchema,
        sessionId: identifierSchema,
        workbenchProjectId: identifierSchema.optional(),
    }),
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
     * One-shot invalidation after a background Project Status refresh replaces its Runtime cache.
     */
    'projectStatus.changed': z.object({ sessionId: identifierSchema }),
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
    /**
     * Main-originated resync signal after the Desktop↔Host connection dropped and re-attached (observed in production
     * on macOS sleep/wake). Transient events sent during the outage — PTY output above all — were never delivered and
     * are not replayable, so the Renderer must re-attach mounted Terminal panes to Runtime's authoritative screen
     * snapshot and refresh converged state. The fields mirror the `server_connection.reconnected` structured log line
     * so a stuck report can be correlated across the Renderer and Main.
     */
    'host.connectionChanged': z.discriminatedUnion('status', [
        z.object({
            status: z.literal('reconnected'),
            downtimeMs: z.number().nonnegative(),
            attempt: z.number().int().positive(),
            isHostReplaced: z.boolean(),
        }),
        z.object({ status: z.literal('replaced') }),
    ]),
    'window.fullScreen': z.object({ isFullScreen: z.boolean() }),
    /**
     * Main-originated, content-free request after Chromium restarts the GPU process. Every mounted Terminal handles
     * this independently so background panes discard invalid WebGL contexts without touching their PTY lifecycle.
     */
    'gpu.recoveryRequested': z.object({ correlationId: z.uuid() }),
    'desktop.openRequested': z.object({
        sessionId: identifierSchema,
        kind: z.enum(['file', 'directory']),
        path: pathSchema.optional(),
        location: editorNavigationTargetSchema.optional(),
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

type ServerEventName = keyof typeof serverEventPayloads;

type ServerEventPayload<E extends ServerEventName> = z.infer<(typeof serverEventPayloads)[E]>;

/**
 * Discriminated union so `onEvent` listeners narrow `payload` from `event` alone.
 */
export type ServerEvent = {
    [E in ServerEventName]: { event: E; payload: ServerEventPayload<E> };
}[ServerEventName];

/**
 * Per-event `{ event, payload }` schema, keyed the same way as `serverEventPayloads`.
 */
type ServerEventSchemaMap = {
    [E in ServerEventName]: z.ZodObject<{
        event: z.ZodLiteral<E>;
        payload: (typeof serverEventPayloads)[E];
    }>;
};

/**
 * `serverEventSchema` is derived from `serverEventPayloads` instead of listing the event names a second time, so a new
 * entry only needs to be added once (to `serverEventPayloads`) to be both a valid payload and a validated member of the
 * discriminated union. `Object.keys`/`.map` can't distribute a generic per array element, so the per-event schema map
 * is built once and cast to `ServerEventSchemaMap` (itself derived from `ServerEventName`, not a hand-listed union) to
 * restore the precise per-event literal types that `z.discriminatedUnion` needs for narrowing.
 */
const serverEventSchemas = Object.fromEntries(
    (Object.keys(serverEventPayloads) as ServerEventName[]).map((event) => [
        event,
        z.object({ event: z.literal(event), payload: serverEventPayloads[event] }),
    ]),
) as ServerEventSchemaMap;

const serverEventSchemaList = Object.values(serverEventSchemas) as [
    ServerEventSchemaMap[ServerEventName],
    ...Array<ServerEventSchemaMap[ServerEventName]>,
];

export const serverEventSchema = z.discriminatedUnion('event', serverEventSchemaList);
