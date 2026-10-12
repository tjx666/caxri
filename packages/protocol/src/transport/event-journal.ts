import { z } from 'zod';

import type { ServerEvent } from '../registry/events.js';
import { serverEventSchema } from '../registry/events.js';
import { CaxriError } from './errors.js';
import { durableServerIdentitySchema, serverStateEpochSchema } from './identity.js';
import { CAXRI_PROTOCOL_VERSION, protocolVersionSchema } from './version.js';

const cursorSchema = z.number().int().nonnegative();

/**
 * One bounded replay window also caps pending durable events during client recovery.
 */
export const MAX_EVENT_JOURNAL_EVENTS = 256;
export type TransientServerEvent = Extract<
    ServerEvent,
    {
        event:
            | 'agentChat.patch'
            | 'agentChat.taskPatch'
            | 'agentCommander.inboxRequested'
            | 'agent.message.held'
            | 'agent.notification'
            | 'agent.automaticNamingUnavailable'
            | 'agent.permissionAutoAllowChanged'
            | 'agent.message.receipt'
            | 'agent.messaging.changed'
            | 'command.execute'
            | 'commanderInbox.changed'
            | 'desktop.openRequested'
            | 'editor.unsavedRequest'
            | 'environment.changed'
            | 'environment.connectionReused'
            | 'externalDocument.changed'
            | 'host.connectionChanged'
            | 'gpu.recoveryRequested'
            | 'gitReview.changed'
            | 'projectStatus.alert'
            | 'projectStatus.changed'
            | 'sessionPullRequests.changed'
            | 'settings.openRequested'
            | 'terminal.output'
            | 'terminal.outputRecovery'
            | 'terminal.resourceAlert'
            | 'terminal.sizeOwnership'
            | 'viewContainers.catalogChanged'
            | 'viewContainers.treeChanged'
            | 'viewContainers.viewChanged'
            | 'workbench.candidate'
            | 'workbench.changed';
    }
>;
export type DurableServerEvent = Exclude<ServerEvent, TransientServerEvent>;

const TRANSIENT_SERVER_EVENT_NAMES = new Set<ServerEvent['event']>([
    'agentChat.patch',
    'agentChat.taskPatch',
    'agent.notification',
    'agent.automaticNamingUnavailable',
    'agent.permissionAutoAllowChanged',
    'terminal.output',
    'terminal.outputRecovery',
    /**
     * Replaying a resource alert after a reconnect would re-notify an episode the user may already have dismissed; the
     * live reading stays available in the status bar and Process Explorer.
     */
    'terminal.resourceAlert',
    'terminal.sizeOwnership',
    'agent.messaging.changed',
    'agent.message.held',
    'agent.message.receipt',
    'command.execute',
    /**
     * An Inbox reader that missed this re-reads the whole list on reconnect, and the list is small and bounded, so a
     * replay would only repeat that read.
     */
    'commanderInbox.changed',
    'desktop.openRequested',
    /**
     * Connection phase and askpass prompts belong to one Main-owned SSH session; a reloaded Renderer reads the current
     * state through `environment.get`, and a replayed prompt would answer a helper that already gave up.
     */
    'environment.changed',
    /**
     * A notice about one connect attempt; a reloaded Renderer has no use for it.
     */
    'environment.connectionReused',
    /**
     * One quit or close decision in flight: replaying it to a later Renderer generation would answer a prompt that
     * already timed out.
     */
    'editor.unsavedRequest',
    /**
     * A change notice for a document the Renderer may no longer have open; a later Renderer re-reads what it opens.
     */
    'externalDocument.changed',
    /**
     * A one-shot Main-side resync trigger: replaying it after the Renderer already re-attached would only force a
     * redundant snapshot round-trip.
     */
    'host.connectionChanged',
    'gpu.recoveryRequested',
    /**
     * The Server-owned review comment store is memory-only (see `docs/git-diff-review.md`): replaying this trigger
     * after a reconnect would invalidate a query cache against data that a restart may already have lost, and the
     * Renderer's own `gitReview.list`/`gitReview.pending` re-fetch on reconnect covers the same ground directly.
     */
    'gitReview.changed',
    /**
     * Replaying a delivery alert after a reconnect would re-notify a failure the user already dismissed.
     */
    'projectStatus.alert',
    'projectStatus.changed',
    'sessionPullRequests.changed',
    /**
     * One-shot: a companion window's Settings deep-link hand-off. Replaying it after a reconnect would re-open Settings
     * the user may have already closed.
     */
    'settings.openRequested',
    /**
     * One-shot: the status bar chip asked the Commander window to show its Inbox. Replaying it after a reconnect would
     * reopen an Inbox the user may have closed since.
     */
    'agentCommander.inboxRequested',
    'viewContainers.catalogChanged',
    'viewContainers.treeChanged',
    'viewContainers.viewChanged',
    'workbench.candidate',
    'workbench.changed',
]);

export function isTransientServerEvent(event: ServerEvent): event is TransientServerEvent {
    return TRANSIENT_SERVER_EVENT_NAMES.has(event.event);
}

export const transientServerEventSchema = serverEventSchema.refine(
    isTransientServerEvent,
    'Only transient events can use direct delivery',
) as z.ZodType<TransientServerEvent>;

/**
 * PTY bytes and one-shot UI commands retain direct delivery and never enter durable replay.
 */
export const durableServerEventSchema = serverEventSchema.refine(
    (event) => !isTransientServerEvent(event),
    'Transient events cannot enter durable protocol replay',
) as z.ZodType<DurableServerEvent>;

const SNAPSHOT_ONLY_DURABLE_EVENT_NAMES = new Set<DurableServerEvent['event']>([
    'agent.dispatch.changed',
    'agentHooks.changed',
    'files.changed',
    'keybindings.changed',
    'settings.changed',
    'theme.changed',
    'updates.state',
]);

/**
 * Payloads on these events may carry configuration sources, paths, or arbitrary failure text. Live delivery preserves
 * the public event, while durable recovery stores only a marker and converges through a bounded snapshot.
 */
export function isSnapshotOnlyDurableEventName(
    event: string,
): event is DurableServerEvent['event'] {
    return SNAPSHOT_ONLY_DURABLE_EVENT_NAMES.has(event as DurableServerEvent['event']);
}

export const protocolEventEnvelopeSchema = z.object({
    protocolVersion: protocolVersionSchema,
    cursor: cursorSchema,
    serverId: durableServerIdentitySchema.optional(),
    stateEpoch: serverStateEpochSchema.optional(),
    event: durableServerEventSchema,
});

export type ProtocolEventEnvelope = z.infer<typeof protocolEventEnvelopeSchema>;

/**
 * Bounded convergence metadata; full Desktop bootstrap data is deliberately not representable.
 */
export const protocolRecoverySnapshotSchema = z.object({
    cursor: cursorSchema,
    projectIds: z.array(z.string().min(1).max(200)).max(1_024),
    sessionIds: z.array(z.string().min(1).max(200)).max(4_096),
    terminalIds: z.array(z.string().min(1).max(200)).max(8_192),
    settingsRevision: z.number().int().nonnegative(),
    diagnosticsRevision: z.number().int().nonnegative(),
    agentRevision: z.number().int().nonnegative(),
});

export type ProtocolRecoverySnapshot = z.infer<typeof protocolRecoverySnapshotSchema>;

const liveRecoveryBarrierSchema = z.object({
    kind: z.literal('live'),
    cursor: cursorSchema,
});

const durableRecoveryIdentityShape = {
    serverId: durableServerIdentitySchema.optional(),
    stateEpoch: serverStateEpochSchema.optional(),
    barrier: liveRecoveryBarrierSchema.optional(),
};

export const eventRecoveryRequestSchema = z.object({
    afterCursor: cursorSchema,
    serverId: durableServerIdentitySchema.optional(),
    stateEpoch: serverStateEpochSchema.optional(),
});

export type EventRecoveryRequest = z.infer<typeof eventRecoveryRequestSchema>;

export const eventRecoverySchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('events'),
        cursor: cursorSchema,
        events: z.array(protocolEventEnvelopeSchema).max(MAX_EVENT_JOURNAL_EVENTS),
        ...durableRecoveryIdentityShape,
    }),
    z.object({
        kind: z.literal('snapshot'),
        cursor: cursorSchema,
        snapshot: protocolRecoverySnapshotSchema,
        ...durableRecoveryIdentityShape,
    }),
]);

export type EventRecovery = z.infer<typeof eventRecoverySchema>;

const OBSERVABLE_EVENT_NAMES = {
    'runtime.status': true,
    'state.changed': true,
    'agentTranscript.changed': true,
    'terminal.exit': true,
    'files.changed': true,
    'files.operationChanged': true,
    'git.changed': true,
    'settings.changed': true,
    'agentHooks.changed': true,
    'agent.dispatch.changed': true,
    'keybindings.changed': true,
    'theme.changed': true,
    'updates.state': true,
    'window.fullScreen': true,
} as const satisfies Record<DurableServerEvent['event'], true>;
export const observableEventNameSchema = z.enum(
    Object.keys(OBSERVABLE_EVENT_NAMES) as [
        DurableServerEvent['event'],
        ...Array<DurableServerEvent['event']>,
    ],
);
const observableEventEnvelopeSchema = z.object({
    cursor: cursorSchema,
    event: observableEventNameSchema,
});

export const observableEventRecoverySchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('events'),
        cursor: cursorSchema,
        events: z.array(observableEventEnvelopeSchema).max(MAX_EVENT_JOURNAL_EVENTS),
    }),
    z.object({
        kind: z.literal('snapshot'),
        cursor: cursorSchema,
        gap: z.literal(true),
    }),
]);
export type ObservableEventRecovery = z.infer<typeof observableEventRecoverySchema>;

/**
 * Removes every event payload and snapshot identity before recovery reaches a non-Desktop client.
 */
export function projectObservableEventRecovery(recovery: EventRecovery): ObservableEventRecovery {
    return observableEventRecoverySchema.parse(
        recovery.kind === 'events'
            ? {
                  kind: 'events',
                  cursor: recovery.cursor,
                  events: recovery.events.map(({ cursor, event }) => ({
                      cursor,
                      event: event.event,
                  })),
              }
            : { kind: 'snapshot', cursor: recovery.cursor, gap: true },
    );
}

export interface DurableEventStore {
    appendEvent(
        stateEpoch: string,
        event: DurableServerEvent,
        createdAt?: number,
    ): ProtocolEventEnvelope;
    changefeedBounds(stateEpoch: string): { count: number; earliest: number; latest: number };
    eventsAfter(stateEpoch: string, afterSequence: number): DurableEventStorePage;
}

export interface DurableEventStorePage {
    events: ProtocolEventEnvelope[];
    requiresSnapshot: boolean;
}

export interface DurableEventJournal {
    publish(event: ServerEvent): ProtocolEventEnvelope;
    recover(request: EventRecoveryRequest): Promise<EventRecovery>;
}

export interface DurableRecoveryObservation {
    cursor: number;
    durationMs: number;
    eventCount: number;
    outcome: 'catch-up' | 'snapshot';
    reason: 'matched' | 'cursor-expired' | 'identity-mismatch' | 'snapshot-required';
}

/**
 * Persists content-free invalidations and freezes a sequence barrier before an asynchronous snapshot. Events appended
 * after that barrier remain on the live lane, so snapshot/catch-up and live delivery cannot overlap or leave a gap.
 */
export function createDurableEventJournal(options: {
    identity: { serverId: string; stateEpoch: string };
    observe?(observation: DurableRecoveryObservation): void;
    snapshot(cursor: number): Promise<ProtocolRecoverySnapshot> | ProtocolRecoverySnapshot;
    store: DurableEventStore;
}): DurableEventJournal {
    const serverId = durableServerIdentitySchema.parse(options.identity.serverId);
    const stateEpoch = serverStateEpochSchema.parse(options.identity.stateEpoch);
    const attachIdentity = (envelope: ProtocolEventEnvelope): ProtocolEventEnvelope =>
        protocolEventEnvelopeSchema.parse({ ...envelope, serverId, stateEpoch });
    const observe = (observation: DurableRecoveryObservation): void => {
        try {
            options.observe?.(observation);
        } catch {
            // Observability is best-effort and must never change recovery semantics.
        }
    };
    return {
        publish(event) {
            const durableEvent = durableServerEventSchema.parse(event);
            return attachIdentity(options.store.appendEvent(stateEpoch, durableEvent));
        },
        async recover(rawRequest) {
            const startedAt = performance.now();
            const request = eventRecoveryRequestSchema.parse(rawRequest);
            const bounds = options.store.changefeedBounds(stateEpoch);
            const recoveryCursor = bounds.latest;
            const isIdentityMismatch =
                (request.serverId !== undefined && request.serverId !== serverId) ||
                (request.stateEpoch !== undefined && request.stateEpoch !== stateEpoch);
            const isCursorExpired =
                request.afterCursor > recoveryCursor ||
                (bounds.count === 0
                    ? request.afterCursor !== 0
                    : request.afterCursor < bounds.earliest - 1);
            const barrier = { kind: 'live' as const, cursor: recoveryCursor };
            if (isIdentityMismatch || isCursorExpired) {
                const snapshot = protocolRecoverySnapshotSchema.parse(
                    await options.snapshot(recoveryCursor),
                );
                if (snapshot.cursor !== recoveryCursor)
                    throw new CaxriError('INTERNAL', 'Recovery snapshot cursor does not match');
                observe({
                    cursor: recoveryCursor,
                    durationMs: performance.now() - startedAt,
                    eventCount: 0,
                    outcome: 'snapshot',
                    reason: isIdentityMismatch ? 'identity-mismatch' : 'cursor-expired',
                });
                return eventRecoverySchema.parse({
                    kind: 'snapshot',
                    cursor: recoveryCursor,
                    serverId,
                    stateEpoch,
                    barrier,
                    snapshot,
                });
            }
            const page = options.store.eventsAfter(stateEpoch, request.afterCursor);
            if (page.requiresSnapshot) {
                const snapshot = protocolRecoverySnapshotSchema.parse(
                    await options.snapshot(recoveryCursor),
                );
                if (snapshot.cursor !== recoveryCursor)
                    throw new CaxriError('INTERNAL', 'Recovery snapshot cursor does not match');
                observe({
                    cursor: recoveryCursor,
                    durationMs: performance.now() - startedAt,
                    eventCount: 0,
                    outcome: 'snapshot',
                    reason: 'snapshot-required',
                });
                return eventRecoverySchema.parse({
                    kind: 'snapshot',
                    cursor: recoveryCursor,
                    serverId,
                    stateEpoch,
                    barrier,
                    snapshot,
                });
            }
            const events = page.events
                .filter(({ cursor }) => cursor <= recoveryCursor)
                .map(attachIdentity);
            let expectedCursor = request.afterCursor + 1;
            for (const event of events) {
                if (event.cursor !== expectedCursor)
                    throw new CaxriError('INTERNAL', 'Durable changefeed suffix is not contiguous');
                expectedCursor += 1;
            }
            if (expectedCursor - 1 !== recoveryCursor)
                throw new CaxriError(
                    'INTERNAL',
                    'Durable changefeed suffix ended before its barrier',
                );
            observe({
                cursor: recoveryCursor,
                durationMs: performance.now() - startedAt,
                eventCount: events.length,
                outcome: 'catch-up',
                reason: 'matched',
            });
            return eventRecoverySchema.parse({
                kind: 'events',
                cursor: recoveryCursor,
                serverId,
                stateEpoch,
                barrier,
                events,
            });
        },
    };
}

export interface EventJournal {
    publish(event: ServerEvent): ProtocolEventEnvelope;
    recover(afterCursor: number): Promise<EventRecovery>;
}

/**
 * Keeps only a bounded replay window and falls back to a bounded identity/revision snapshot.
 */
export function createEventJournal(options: {
    snapshot(cursor: number): Promise<ProtocolRecoverySnapshot> | ProtocolRecoverySnapshot;
    maximumEvents?: number;
}): EventJournal {
    const maximumEvents = options.maximumEvents ?? MAX_EVENT_JOURNAL_EVENTS;
    if (
        !Number.isSafeInteger(maximumEvents) ||
        maximumEvents < 1 ||
        maximumEvents > MAX_EVENT_JOURNAL_EVENTS
    )
        throw new CaxriError(
            'VALIDATION',
            `Event journal capacity must be between 1 and ${MAX_EVENT_JOURNAL_EVENTS}`,
        );
    let cursor = 0;
    const events: ProtocolEventEnvelope[] = [];
    return {
        publish(event) {
            const envelope = protocolEventEnvelopeSchema.parse({
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                cursor: ++cursor,
                event,
            });
            events.push(envelope);
            if (events.length > maximumEvents) events.shift();
            return envelope;
        },
        async recover(afterCursor) {
            cursorSchema.parse(afterCursor);
            /**
             * Freeze the barrier before any async snapshot read; later events remain replayable.
             */
            const recoveryCursor = cursor;
            if (afterCursor > recoveryCursor)
                throw new CaxriError('VALIDATION', 'Event cursor is ahead of the Host');
            const earliest = events[0]?.cursor ?? recoveryCursor + 1;
            if (afterCursor < earliest - 1) {
                const snapshot = protocolRecoverySnapshotSchema.parse(
                    await options.snapshot(recoveryCursor),
                );
                if (snapshot.cursor !== recoveryCursor)
                    throw new CaxriError('INTERNAL', 'Recovery snapshot cursor does not match');
                return { kind: 'snapshot', cursor: recoveryCursor, snapshot };
            }
            return {
                kind: 'events',
                cursor: recoveryCursor,
                events: events.filter(
                    (event) => event.cursor > afterCursor && event.cursor <= recoveryCursor,
                ),
            };
        },
    };
}

/**
 * Drops duplicate replay and reports the first gap so a client can request convergence.
 */
export function acceptEventSequence(
    currentCursor: number,
    incoming: readonly ProtocolEventEnvelope[],
):
    | { kind: 'accepted'; cursor: number; events: ServerEvent[] }
    | { kind: 'gap'; cursor: number; expectedCursor: number; receivedCursor: number } {
    cursorSchema.parse(currentCursor);
    const events: ServerEvent[] = [];
    let cursor = currentCursor;
    for (const value of incoming) {
        const envelope = protocolEventEnvelopeSchema.parse(value);
        if (envelope.cursor <= cursor) continue;
        if (envelope.cursor !== cursor + 1) {
            return {
                kind: 'gap',
                cursor,
                expectedCursor: cursor + 1,
                receivedCursor: envelope.cursor,
            };
        }
        cursor = envelope.cursor;
        events.push(envelope.event);
    }
    return { kind: 'accepted', cursor, events };
}
