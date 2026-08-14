import { z } from 'zod';

import { CaxriError } from './errors.js';
import { runtimeEventSchema, type RuntimeEvent } from '../registry/events.js';
import { CAXRI_PROTOCOL_VERSION, protocolVersionSchema } from './version.js';

const cursorSchema = z.number().int().nonnegative();

/** One bounded replay window also caps pending durable events during client recovery. */
export const MAX_EVENT_JOURNAL_EVENTS = 256;
export type TransientRuntimeEvent = Extract<
    RuntimeEvent,
    {
        event:
            | 'agent.message.held'
            | 'agent.message.receipt'
            | 'agent.messaging.changed'
            | 'command.execute'
            | 'desktop.openRequested'
            | 'terminal.output';
    }
>;
export type DurableRuntimeEvent = Exclude<RuntimeEvent, TransientRuntimeEvent>;

export function isTransientRuntimeEvent(event: RuntimeEvent): event is TransientRuntimeEvent {
    return (
        event.event === 'terminal.output' ||
        event.event === 'agent.messaging.changed' ||
        event.event === 'agent.message.held' ||
        event.event === 'agent.message.receipt' ||
        event.event === 'command.execute' ||
        event.event === 'desktop.openRequested'
    );
}

export const transientRuntimeEventSchema = runtimeEventSchema.refine(
    isTransientRuntimeEvent,
    'Only transient events can use direct delivery',
) as z.ZodType<TransientRuntimeEvent>;

/** PTY bytes and one-shot UI commands retain direct delivery and never enter durable replay. */
export const durableRuntimeEventSchema = runtimeEventSchema.refine(
    (event) => !isTransientRuntimeEvent(event),
    'Transient events cannot enter durable protocol replay',
) as z.ZodType<DurableRuntimeEvent>;

export const protocolEventEnvelopeSchema = z.object({
    protocolVersion: protocolVersionSchema,
    cursor: cursorSchema,
    event: durableRuntimeEventSchema,
});

export type ProtocolEventEnvelope = z.infer<typeof protocolEventEnvelopeSchema>;

/** Bounded convergence metadata; full Desktop bootstrap data is deliberately not representable. */
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

export const eventRecoverySchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('events'),
        cursor: cursorSchema,
        events: z.array(protocolEventEnvelopeSchema).max(MAX_EVENT_JOURNAL_EVENTS),
    }),
    z.object({
        kind: z.literal('snapshot'),
        cursor: cursorSchema,
        snapshot: protocolRecoverySnapshotSchema,
    }),
]);

export type EventRecovery = z.infer<typeof eventRecoverySchema>;

const OBSERVABLE_EVENT_NAMES = {
    'runtime.status': true,
    'state.changed': true,
    'terminal.exit': true,
    'files.changed': true,
    'files.operationChanged': true,
    'settings.changed': true,
    'agentHooks.changed': true,
    'agent.dispatch.changed': true,
    'keybindings.changed': true,
    'theme.changed': true,
    'updates.state': true,
    'window.fullScreen': true,
} as const satisfies Record<DurableRuntimeEvent['event'], true>;
export const observableEventNameSchema = z.enum(
    Object.keys(OBSERVABLE_EVENT_NAMES) as [
        DurableRuntimeEvent['event'],
        ...Array<DurableRuntimeEvent['event']>,
    ],
);
export const observableEventRecoverySchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('events'),
        cursor: cursorSchema,
        events: z
            .array(z.object({ cursor: cursorSchema, event: observableEventNameSchema }))
            .max(MAX_EVENT_JOURNAL_EVENTS),
    }),
    z.object({
        kind: z.literal('snapshot'),
        cursor: cursorSchema,
        gap: z.literal(true),
    }),
]);
export type ObservableEventRecovery = z.infer<typeof observableEventRecoverySchema>;

/** Removes every event payload and snapshot identity before recovery reaches a non-Desktop client. */
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

export interface EventJournal {
    publish(event: RuntimeEvent): ProtocolEventEnvelope;
    recover(afterCursor: number): Promise<EventRecovery>;
}

/** Keeps only a bounded replay window and falls back to a bounded identity/revision snapshot. */
export function createEventJournal(options: {
    snapshot(cursor: number): Promise<ProtocolRecoverySnapshot> | ProtocolRecoverySnapshot;
    maximumEvents?: number;
}): EventJournal {
    const maximumEvents = options.maximumEvents ?? MAX_EVENT_JOURNAL_EVENTS;
    if (
        !Number.isInteger(maximumEvents) ||
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
            /** Freeze the barrier before any async snapshot read; later events remain replayable. */
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

/** Drops duplicate replay and reports the first gap so a client can request convergence. */
export function acceptEventSequence(
    currentCursor: number,
    incoming: readonly ProtocolEventEnvelope[],
):
    | { kind: 'accepted'; cursor: number; events: RuntimeEvent[] }
    | { kind: 'gap'; cursor: number; expectedCursor: number; receivedCursor: number } {
    cursorSchema.parse(currentCursor);
    const events: RuntimeEvent[] = [];
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
