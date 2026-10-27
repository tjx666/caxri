import type { BotInputTakeBack, BotManagedSessions, BotStatus, ServerEvent } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { fetchCaxriQuery } from '../../queries/client';
import { getBootstrap } from '../../stores/selectors';
import type { ToastAction } from '../../stores/toast-actions';
import { pushToast } from '../../stores/toasts';
import { sessionTitleForDisplay } from '../session/session-title';

/**
 * What a Workbench Session row says about Caxri Bot ownership: nothing, managed, managed through a hand-over that
 * typing into its PTY Agent ends, or one that sending or stopping in its Agent Chat ends (a Chat draft takes nothing
 * back).
 */
export type BotSessionMarker = 'none' | 'managed' | 'inputTakesBack' | 'chatInputTakesBack';

/**
 * The marker for one Session. A stopped Caxri Bot (`runState` `stopped`, or not read yet) shows none: the Sessions stay
 * handed over so a restarted Caxri Bot picks them up again, but while nothing runs no one is managing them, and a
 * marker that outlives quitting Caxri Bot reads as if it were still in charge.
 */
export function botSessionMarker(
    managed: Pick<
        BotManagedSessions,
        'chatTakeBackSessionIds' | 'inputTakeBackSessionIds' | 'sessionIds'
    >,
    sessionId: string,
    runState: BotStatus['state'] | undefined,
): BotSessionMarker {
    if (runState === undefined || runState === 'stopped') return 'none';
    if (managed.chatTakeBackSessionIds.includes(sessionId)) return 'chatInputTakesBack';
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
    takeBacks: readonly BotInputTakeBack[],
): { fresh: BotInputTakeBack[]; seen: Set<string> } {
    return {
        fresh: seen ? takeBacks.filter((takeBack) => !seen.has(takeBack.id)) : [],
        seen: new Set(takeBacks.map((takeBack) => takeBack.id)),
    };
}

/**
 * Whether an event can have changed the managed set. Every hand-over and take-back announces a full `state.changed`; a
 * Server restart or reconnect may have lost events, and a restarted Server Core starts with an empty take-back list.
 */
export function isBotManagedSessionsEvent(event: ServerEvent): boolean {
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

/**
 * The notice for one take-back: which Session the user's typing took back, and a Hand Back follow-up, because the
 * take-back happens the moment the user types, with no confirmation, and this is its way back.
 */
export function inputTakeBackNotice(
    takeBack: Pick<BotInputTakeBack, 'sessionId'>,
    title: string | undefined,
    t: Translate = translate,
): { message: string; action: ToastAction } {
    return {
        message: title
            ? t('caxriBot.handover.takenBackByInput', {
                  title: sessionTitleForDisplay(title, t),
              })
            : t('caxriBot.handover.takenBackByInputUntitled'),
        action: { id: 'caxriBot.handBack', params: { sessionId: takeBack.sessionId } },
    };
}

function announce(takeBack: BotInputTakeBack): void {
    const title = getBootstrap()?.sessions.find(
        (session) => session.id === takeBack.sessionId,
    )?.title;
    const { action, message } = inputTakeBackNotice(takeBack, title);
    pushToast('info', message, { action });
}

async function refreshManagedSessions(): Promise<void> {
    let managed: BotManagedSessions;
    try {
        managed = await fetchCaxriQuery('bot.managedSessions', {}, { staleTime: 0 });
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
 * Keeps the shared `bot.managedSessions` read current in the Workbench window and announces each take-back the user
 * caused by typing into a handed-over Agent, which otherwise ends Caxri Bot's management with no trace.
 * Reference-counted: the Session rows that draw the marker and the status bar both hold it, so the notice still arrives
 * while the sidebar is collapsed, and one subscription serves them all. Returns the release.
 */
export function retainBotManagedSessionsFeed(): () => void {
    feed.holders += 1;
    if (feed.holders === 1) {
        feed.unsubscribe = caxri.onEvent((event) => {
            // Fire-and-forget: a failed read keeps the last answer and the next event retries.
            if (isBotManagedSessionsEvent(event)) void refreshManagedSessions();
        });
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
