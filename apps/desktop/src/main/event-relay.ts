import type { BootstrapState, EventRecovery, LogEventName, ServerEvent } from '@caxri/protocol';
import { createEventJournal, isTransientServerEvent, logEventCatalog } from '@caxri/protocol';

interface EventLogger {
    write(
        level: 'error' | 'info',
        event: LogEventName,
        fields: { fields: Record<string, boolean | null | number | string> },
    ): void;
}

export interface MainEventRelayOptions {
    /**
     * Sends one event to the windows that should see it. `windowKey` is set for a retained notice replayed to one
     * window and for a `target` event addressed to a single window; otherwise the audience is the event's own.
     */
    deliver(message: unknown, event: ServerEvent, windowKey?: string): void;
    loadState(): Promise<BootstrapState>;
    logger(): EventLogger | undefined;
    onMenuRefreshRequested(): void;
}

/**
 * Owns only Renderer-reload recovery; the profile-wide durable cursor lives in Server Core.
 */
export function createMainEventRelay(options: MainEventRelayOptions) {
    /**
     * The Workbench windows whose current Renderer generation subscribed to events. A replacement notice is held until
     * one is ready, and replayed to each window as it becomes ready.
     */
    const readyWindows = new Set<string>();
    let retainedDesktopLeaseReplacement: ServerEvent | undefined;
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
        rendererPending(windowKey: string): void {
            readyWindows.delete(windowKey);
        },
        rendererReady(windowKey: string): void {
            if (readyWindows.has(windowKey)) return;
            readyWindows.add(windowKey);
            if (retainedDesktopLeaseReplacement)
                options.deliver(
                    retainedDesktopLeaseReplacement,
                    retainedDesktopLeaseReplacement,
                    windowKey,
                );
        },
        /**
         * Forgets a closed window so it stops counting as a ready audience.
         */
        windowClosed(windowKey: string): void {
            readyWindows.delete(windowKey);
        },
        send(event: ServerEvent, windowKey?: string): void {
            if (event.event === 'host.connectionChanged' && event.payload.status === 'replaced') {
                /**
                 * Replacement permanently stops this Main instance from reconnecting. Retain the notice across the
                 * startup and navigation gap so a later Renderer generation cannot miss the only recovery guidance.
                 */
                retainedDesktopLeaseReplacement = event;
                if (readyWindows.size === 0) return;
            }
            if (event.event === 'runtime.status')
                options
                    .logger()
                    ?.write(
                        event.payload.status === 'failed' ? 'error' : 'info',
                        logEventCatalog.serverCore.status,
                        {
                            fields: {
                                status: event.payload.status,
                                restartCount: event.payload.restartCount,
                            },
                        },
                    );
            options.deliver(
                isTransientServerEvent(event) ? event : journal.publish(event),
                event,
                windowKey,
            );
            if (
                (event.event === 'keybindings.changed' && !event.payload.error) ||
                // The menu labels follow `workbench.language`; the event names no key, so any change rebuilds it.
                event.event === 'settings.changed' ||
                (event.event === 'state.changed' &&
                    event.payload.kind === 'full' &&
                    event.payload.reason === 'unknown') ||
                (event.event === 'runtime.status' && event.payload.status === 'ready') ||
                (event.event === 'host.connectionChanged' && event.payload.status === 'reconnected')
            )
                options.onMenuRefreshRequested();
        },
    };
}
