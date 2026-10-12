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
    deliver(message: unknown): void;
    loadState(): Promise<BootstrapState>;
    logger(): EventLogger | undefined;
    onMenuRefreshRequested(): void;
}

/**
 * Owns only Renderer-reload recovery; the profile-wide durable cursor lives in Server Core.
 */
export function createMainEventRelay(options: MainEventRelayOptions) {
    let isRendererReady = false;
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
        rendererPending(): void {
            isRendererReady = false;
        },
        rendererReady(): void {
            if (isRendererReady) return;
            isRendererReady = true;
            if (retainedDesktopLeaseReplacement) options.deliver(retainedDesktopLeaseReplacement);
        },
        send(event: ServerEvent): void {
            if (event.event === 'host.connectionChanged' && event.payload.status === 'replaced') {
                /**
                 * Replacement permanently stops this Main instance from reconnecting. Retain the notice across the
                 * startup and navigation gap so a later Renderer generation cannot miss the only recovery guidance.
                 */
                retainedDesktopLeaseReplacement = event;
                if (!isRendererReady) return;
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
            options.deliver(isTransientServerEvent(event) ? event : journal.publish(event));
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
