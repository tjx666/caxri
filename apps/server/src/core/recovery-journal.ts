import type {
    DurableEventStore,
    DurableRecoveryObservation,
    EventRecovery,
    EventRecoveryRequest,
    ProtocolEventEnvelope,
    ProtocolRecoverySnapshot,
    ServerEvent,
} from '@caxri/protocol';
import { CaxriError, createDurableEventJournal, MAX_EVENT_JOURNAL_EVENTS } from '@caxri/protocol';

import type { ServerDomainService } from './domain-service';

export interface ServerRecoveryJournal {
    initialize(identity: { serverId: string; stateEpoch: string }, store: DurableEventStore): void;
    publish(event: ServerEvent): ProtocolEventEnvelope | undefined;
    recover(request: EventRecoveryRequest): Promise<EventRecovery>;
}

/**
 * The recovery snapshot a Client resynchronizes from when its cursor fell outside the journal: the live entity ids,
 * with every revision pinned to the cursor.
 */
export const serverRecoverySnapshot =
    (domainService: ServerDomainService) =>
    async (cursor: number): Promise<ProtocolRecoverySnapshot> => {
        const state = await domainService.request('app.bootstrap');
        return {
            cursor,
            projectIds: state.projects.map(({ id }) => id),
            sessionIds: state.sessions.map(({ id }) => id),
            terminalIds: state.terminals.map(({ id }) => id),
            settingsRevision: cursor,
            diagnosticsRevision: cursor,
            agentRevision: cursor,
        };
    };

/**
 * Bridges the short startup interval where domain readiness can emit before its persistence port becomes available. The
 * bounded queue is drained synchronously before the control listener starts, so no Client can observe a gap.
 */
export function createServerRecoveryJournal(
    snapshot: (cursor: number) => Promise<ProtocolRecoverySnapshot> | ProtocolRecoverySnapshot,
    observe?: (observation: DurableRecoveryObservation) => void,
): ServerRecoveryJournal {
    let journal: ReturnType<typeof createDurableEventJournal> | undefined;
    const pending: ServerEvent[] = [];
    return {
        initialize(identity, store) {
            if (journal) throw new CaxriError('CONFLICT', 'Server recovery is already initialized');
            journal = createDurableEventJournal({ identity, observe, snapshot, store });
            for (const event of pending) journal.publish(event);
            pending.length = 0;
        },
        publish(event) {
            if (journal) return journal.publish(event);
            if (pending.length >= MAX_EVENT_JOURNAL_EVENTS)
                throw new CaxriError('CAPACITY', 'Too many durable startup events');
            pending.push(event);
            return;
        },
        recover(request) {
            if (!journal)
                return Promise.reject(
                    new CaxriError('UNAVAILABLE', 'Server recovery is not ready'),
                );
            return journal.recover(request);
        },
    };
}
