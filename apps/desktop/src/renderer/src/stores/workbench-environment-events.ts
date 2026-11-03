import type { BootstrapState, ServerEvent } from '@caxri/protocol';

import { reportTerminalNoticeEvent } from '../features/terminal/terminal-notice-events';
import {
    dismissWorkbenchRootCandidate,
    showWorkbenchRootCandidate,
} from '../features/workbench/workbench-root-prompt-store';
import { reportAutomaticNamingNotices } from './automatic-naming-notice';
import { environmentIdOf, useEnvironmentStore } from './environment';
import {
    isSessionCommandConvergenceReason,
    resolveNextSessionCommandConvergence,
} from './session-command-convergence';
import { markEnvironmentChanged } from './workbench-environments';
import { recordNotificationEvent } from './workbench-event-notifications';
import { reportWorkbenchRootChange } from './workbench-root-notice';

/**
 * Events that only show a notice or record a notification, handled alike for every machine.
 */
type NoticeEvent = Extract<
    ServerEvent,
    {
        event:
            | 'agent.automaticNamingUnavailable'
            | 'agent.notification'
            | 'notifications.helperUnavailable'
            | 'projectStatus.alert'
            | 'session.autoArchived'
            | 'terminal.outputRecovery'
            | 'terminal.ptyAlert'
            | 'terminal.resourceAlert'
            | 'workbench.candidate'
            | 'workbench.changed';
    }
>;

const NOTICE_EVENTS: ReadonlySet<string> = new Set<NoticeEvent['event']>([
    'agent.automaticNamingUnavailable',
    'agent.notification',
    'notifications.helperUnavailable',
    'projectStatus.alert',
    'session.autoArchived',
    'terminal.outputRecovery',
    'terminal.ptyAlert',
    'terminal.resourceAlert',
    'workbench.candidate',
    'workbench.changed',
]);

export function isNoticeEvent(event: ServerEvent): event is NoticeEvent {
    return NOTICE_EVENTS.has(event.event);
}

export function reportNoticeEvent(event: NoticeEvent, bootstrap: BootstrapState | undefined): void {
    switch (event.event) {
        case 'workbench.candidate':
            showWorkbenchRootCandidate(event.payload);
            return;
        case 'workbench.changed':
            dismissWorkbenchRootCandidate(event.payload.sessionId);
            reportWorkbenchRootChange(event.payload);
            return;
        case 'terminal.outputRecovery':
        case 'terminal.ptyAlert':
        case 'terminal.resourceAlert':
            reportTerminalNoticeEvent(event);
            return;
        case 'agent.automaticNamingUnavailable':
            reportAutomaticNamingNotices([event.payload], bootstrap);
            return;
        default:
            recordNotificationEvent(event, bootstrap);
    }
}

/**
 * Handles an SSH Host's event. Its records converge through a fresh read of that Host's snapshot rather than the record
 * refresh, whose batched ids may span Servers; its notices are shown like this Mac's. Device events never arrive here
 * (`lib/caxri.ts` drops them).
 */
export function createEnvironmentEventHandler(workbench: {
    bootstrap: () => BootstrapState | undefined;
    refresh: () => Promise<void>;
}): (event: ServerEvent, environmentId: string) => void {
    return (event, environmentId) => {
        if (isNoticeEvent(event)) {
            reportNoticeEvent(event, workbench.bootstrap());
            return;
        }
        if (event.event !== 'state.changed') return;
        markEnvironmentChanged(environmentId);
        const refresh = workbench.refresh();
        if (
            event.payload.kind === 'full' &&
            isSessionCommandConvergenceReason(event.payload.reason)
        )
            resolveNextSessionCommandConvergence(event.payload.reason, refresh);
    };
}

/**
 * Re-reads the Workbench when an SSH Host connects, reconnects, or is disconnected, and re-attaches Terminal panes
 * after a reconnect, since PTY output sent while the connection was down is not replayed. A Host that is only
 * reconnecting keeps its last snapshot, so its Projects stay in the side bar instead of flickering out.
 */
export function watchEnvironmentConnections(workbench: {
    bumpAttachEpoch: () => void;
    refresh: () => Promise<void>;
}): () => void {
    let listed = new Set<string>();
    let connected = new Set<string>();
    const isSame = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
        a.size === b.size && [...a].every((id) => b.has(id));
    return useEnvironmentStore.subscribe((state) => {
        const nextListed = new Set(state.hosts.map(environmentIdOf));
        const nextConnected = new Set(
            state.hosts.filter((host) => host.phase === 'connected').map(environmentIdOf),
        );
        if (isSame(nextListed, listed) && isSame(nextConnected, connected)) return;
        const newlyConnected = [...nextConnected].filter((id) => !connected.has(id));
        listed = nextListed;
        connected = nextConnected;
        for (const id of newlyConnected) markEnvironmentChanged(id);
        if (newlyConnected.length > 0) workbench.bumpAttachEpoch();
        void workbench.refresh();
    });
}
