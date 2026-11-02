import type { ServerEvent } from '@caxri/protocol';
import { errorMessage, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';

interface ProjectRunningOrderEvents {
    /**
     * Binds the database once Root Services opened it and reconciles once; earlier events pass through untouched.
     */
    attach: (database: CaxriDatabase) => void;
    send: (event: ServerEvent) => void;
}

/**
 * Wraps the domain event sink so every `state.changed` reconciles the running Project order.
 *
 * An Agent starts or stops running through many writers (hooks, probes, attention replies, archive, deletion), and
 * every one of them announces the change with `state.changed`. Reconciling at that single sink keeps the rule in one
 * place instead of hooking each writer, and a writer added later is covered without knowing the rule exists. A moved
 * order is announced as its own full state change, because a `records` event only refreshes the named Sessions and
 * Terminals, never the Project list.
 */
export function createProjectRunningOrderEvents(
    send: (event: ServerEvent) => void,
    logger: StructuredLogger,
): ProjectRunningOrderEvents {
    let database: CaxriDatabase | undefined;
    const reconcile = (): void => {
        if (!database) return;
        try {
            const change = database.reconcileProjectRunningOrder();
            if (!change) return;
            logger.write('info', logEventCatalog.database.projectRunningOrderChanged, {
                fields: {
                    started: change.started.length,
                    stopped: change.stopped.length,
                    running: change.running.length,
                },
            });
            send({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'project.runningOrder' },
            });
        } catch (error) {
            // The triggering event was already delivered; a failed reorder must not interrupt its sender.
            logger.write('warn', logEventCatalog.database.projectRunningOrderFailed, {
                fields: { error: errorMessage(error, 'unknown') },
            });
        }
    };
    return {
        attach(attached) {
            database = attached;
            // Agents that started or stopped while Server Core was down move once at startup.
            reconcile();
        },
        send(event) {
            send(event);
            if (event.event !== 'state.changed') return;
            if (event.payload.kind === 'full' && event.payload.reason === 'project.runningOrder')
                return;
            reconcile();
        },
    };
}
