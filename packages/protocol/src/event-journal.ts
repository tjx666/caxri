import { z } from 'zod';

import { CaxriError } from './errors.js';
import { runtimeEventSchema, type RuntimeEvent } from './events.js';
import { CAXRI_PROTOCOL_VERSION, protocolVersionSchema } from './version.js';

const cursorSchema = z.number().int().nonnegative();
export type TransientRuntimeEvent = Extract<
    RuntimeEvent,
    { event: 'command.execute' | 'terminal.output' }
>;

/** PTY bytes and one-shot UI commands retain direct delivery and never enter durable replay. */
export const durableRuntimeEventSchema = runtimeEventSchema.refine(
    (event) => event.event !== 'terminal.output' && event.event !== 'command.execute',
    'Transient events cannot enter durable protocol replay',
);

export function isTransientRuntimeEvent(event: RuntimeEvent): event is TransientRuntimeEvent {
    return event.event === 'terminal.output' || event.event === 'command.execute';
}

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
        events: z.array(protocolEventEnvelopeSchema).max(256),
    }),
    z.object({
        kind: z.literal('snapshot'),
        cursor: cursorSchema,
        snapshot: protocolRecoverySnapshotSchema,
    }),
]);

export type EventRecovery = z.infer<typeof eventRecoverySchema>;

export interface EventJournal {
    publish(event: RuntimeEvent): ProtocolEventEnvelope;
    recover(afterCursor: number): Promise<EventRecovery>;
}

/** Keeps only a bounded replay window and falls back to a bounded identity/revision snapshot. */
export function createEventJournal(options: {
    snapshot(cursor: number): Promise<ProtocolRecoverySnapshot> | ProtocolRecoverySnapshot;
    maximumEvents?: number;
}): EventJournal {
    const maximumEvents = options.maximumEvents ?? 256;
    if (!Number.isInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 256)
        throw new CaxriError('VALIDATION', 'Event journal capacity must be between 1 and 256');
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
            if (afterCursor > cursor)
                throw new CaxriError('VALIDATION', 'Event cursor is ahead of the Host');
            const earliest = events[0]?.cursor ?? cursor + 1;
            if (afterCursor < earliest - 1) {
                const snapshot = protocolRecoverySnapshotSchema.parse(
                    await options.snapshot(cursor),
                );
                if (snapshot.cursor !== cursor)
                    throw new CaxriError('INTERNAL', 'Recovery snapshot cursor does not match');
                return { kind: 'snapshot', cursor, snapshot };
            }
            return {
                kind: 'events',
                cursor,
                events: events.filter((event) => event.cursor > afterCursor),
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
