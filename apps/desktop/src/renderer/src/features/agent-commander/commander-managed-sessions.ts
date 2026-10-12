import type {
    CommanderInputTakeBack,
    CommanderManagedSessions,
    ServerEvent,
} from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { fetchCaxriQuery } from '../../queries/client';
import { getBootstrap } from '../../stores/selectors';
import { pushToast } from '../../stores/toasts';
import { sessionTitleForDisplay } from '../session/session-title';

/**
 * What a Workbench Session row says about Commander ownership: nothing, managed, or managed through a hand-over that
 * typing into its Agent ends.
 */
export type CommanderSessionMarker = 'none' | 'managed' | 'inputTakesBack';

export function commanderSessionMarker(
    managed: Pick<CommanderManagedSessions, 'inputTakeBackSessionIds' | 'sessionIds'>,
    sessionId: string,
): CommanderSessionMarker {
    if (managed.inputTakeBackSessionIds.includes(sessionId)) return 'inputTakesBack';
    return managed.sessionIds.includes(sessionId) ? 'managed' : 'none';
}

/**
 * Splits a read's take-backs into the ones this window has not announced yet and the IDs it has now seen. The first
 * read (`seen` undefined) announces nothing: those take-backs happened before this window was listening, and a notice
 * is only worth showing while it is fresh.
 */
export function unseenInputTakeBacks(
    seen: ReadonlySet<string> | undefined,
    takeBacks: readonly CommanderInputTakeBack[],
): { fresh: CommanderInputTakeBack[]; seen: Set<string> } {
    return {
        fresh: seen ? takeBacks.filter((takeBack) => !seen.has(takeBack.id)) : [],
        seen: new Set(takeBacks.map((takeBack) => takeBack.id)),
    };
}

/**
 * Whether an event can have changed the managed set. Every hand-over and take-back announces a full `state.changed`; a
 * Server restart or reconnect may have lost events, and a restarted Server Core starts with an empty take-back list.
 */
export function isCommanderManagedSessionsEvent(event: ServerEvent): boolean {
    switch (event.event) {
        case 'state.changed':
            return event.payload.kind === 'full';
        case 'runtime.status':
            return event.payload.status === 'ready';
        case 'host.connectionChanged':
            return event.payload.status !== 'replaced';
        default:
            return false;
    }
}

const feed: {
    holders: number;
    seen?: Set<string>;
    unsubscribe?: () => void;
} = { holders: 0 };

function announce(takeBack: CommanderInputTakeBack): void {
    const title = getBootstrap()?.sessions.find(
        (session) => session.id === takeBack.sessionId,
    )?.displayTitle;
    pushToast(
        'info',
        title
            ? translate('agentCommander.handover.takenBackByInput', {
                  title: sessionTitleForDisplay(title, translate),
              })
            : translate('agentCommander.handover.takenBackByInputUntitled'),
    );
}

async function refreshManagedSessions(): Promise<void> {
    let managed: CommanderManagedSessions;
    try {
        managed = await fetchCaxriQuery('commander.managedSessions', {}, { staleTime: 0 });
    } catch {
        // The marker keeps its last answer; the next full state change reads again.
        return;
    }
    if (feed.holders === 0) return;
    const { fresh, seen } = unseenInputTakeBacks(feed.seen, managed.inputTakeBacks);
    feed.seen = seen;
    for (const takeBack of fresh) announce(takeBack);
}

/**
 * Keeps the shared `commander.managedSessions` read current in the Workbench window and announces each take-back the
 * user caused by typing into a handed-over Agent, which otherwise ends the Commander's management with no trace.
 * Reference-counted: the Session rows that draw the marker and the status bar both hold it, so the notice still arrives
 * while the sidebar is collapsed, and one subscription serves them all. Returns the release.
 */
export function retainCommanderManagedSessionsFeed(): () => void {
    feed.holders += 1;
    if (feed.holders === 1) {
        feed.unsubscribe = caxri.onEvent((event) => {
            // Fire-and-forget: a failed read keeps the last answer and the next event retries.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            if (isCommanderManagedSessionsEvent(event)) void refreshManagedSessions();
        });
        // eslint-disable-next-line no-void -- the first read sets the baseline; failures retry on the next event
        void refreshManagedSessions();
    }
    let isReleased = false;
    return () => {
        if (isReleased) return;
        isReleased = true;
        feed.holders -= 1;
        if (feed.holders > 0) return;
        feed.unsubscribe?.();
        feed.unsubscribe = undefined;
        feed.seen = undefined;
    };
}
