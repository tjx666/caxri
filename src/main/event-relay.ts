import type { EventRecovery } from '../shared/ipc/event-journal';
import { createEventJournal, isTransientRuntimeEvent } from '../shared/ipc/event-journal';
import type { RuntimeEvent } from '../shared/ipc/events';
import type { BootstrapState } from '../shared/types';

interface EventLogger {
    write(
        level: 'error' | 'info',
        event: string,
        fields: { fields: Record<string, boolean | null | number | string> },
    ): void;
}

export interface MainEventRelayOptions {
    deliver(message: unknown): void;
    loadState(): Promise<BootstrapState>;
    logger(): EventLogger | undefined;
    onKeybindingsChanged(): void;
}

/**
 * Owns only Renderer-reload recovery; the profile-wide durable cursor lives in Headless Host.
 */
export function createMainEventRelay(options: MainEventRelayOptions) {
    const journal = createEventJournal({
        snapshot: async (cursor) => {
            const state = await options.loadState();
            return {
                cursor,
                projectIds: state.projects.map(({ id }) => id),
                sessionIds: state.sessions.map(({ id }) => id),
                terminalIds: state.terminals.map(({ id }) => id),
                /**
                 * These domains converge through principal-specific reads after snapshot recovery.
                 */
                settingsRevision: cursor,
                diagnosticsRevision: cursor,
                agentRevision: cursor,
            };
        },
    });

    return {
        recover(afterCursor: number): Promise<EventRecovery> {
            return journal.recover(afterCursor);
        },
        send(event: RuntimeEvent): void {
            if (event.event === 'runtime.status')
                options
                    .logger()
                    ?.write(
                        event.payload.status === 'failed' ? 'error' : 'info',
                        'runtime.status',
                        {
                            fields: {
                                status: event.payload.status,
                                restartCount: event.payload.restartCount,
                            },
                        },
                    );
            options.deliver(isTransientRuntimeEvent(event) ? event : journal.publish(event));
            if (event.event === 'keybindings.changed' && !event.payload.error)
                options.onKeybindingsChanged();
        },
    };
}
