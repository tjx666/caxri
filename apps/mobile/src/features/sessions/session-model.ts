import type { MethodResult, SessionActivityGroupId } from '@caxri/protocol';
import {
    compareSessionActivityGroupRows,
    compareSessionPinnedOrder,
    isPinnedSession,
    SESSION_ACTIVITY_GROUP_ORDER,
    sessionActivityGroup,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { getLocale } from '../../i18n/locale-store';
import { resetClockTime } from '../agent-usage/agent-usage-model';

export type MobileSession = MethodResult<'mobile.dashboard'>['sessions'][number];
export type MobileTerminal = NonNullable<MobileSession['primaryTerminal']>;

/**
 * The home list's sections in order: Pinned, then the status groups Desktop's Activity view uses (see
 * `session-activity-group.ts` in `@caxri/protocol`), so a Session sits under the same heading on both.
 */
export const MOBILE_SESSION_LIST_GROUPS = ['pinned', ...SESSION_ACTIVITY_GROUP_ORDER] as const;

export type MobileSessionListGroup = (typeof MOBILE_SESSION_LIST_GROUPS)[number];

export interface MobileSessionItem extends MobileSession {
    /**
     * The Session's status group. A pinned Session still has one (it drives the row's status glyph), but is listed only
     * under Pinned.
     */
    group: SessionActivityGroupId;
    primaryTerminal?: MobileTerminal;
    projectTitle: string;
    stateLabel: string;
}

export interface MobileSessionSections {
    groups: Record<MobileSessionListGroup, MobileSessionItem[]>;
    /**
     * Every Session once, in list order: a pinned Session is listed only under Pinned.
     */
    sessions: MobileSessionItem[];
    total: number;
    truncated: boolean;
}

export const emptyMobileSessionGroups = (): Record<
    MobileSessionListGroup,
    MobileSessionItem[]
> => ({
    pinned: [],
    attention: [],
    working: [],
    waiting: [],
    failed: [],
    finished: [],
    idle: [],
});

const labelForState = (session: MobileSession, t: Translate): string => {
    switch (session.agentActivityState) {
        case 'waiting':
            return t('sessions.state.waiting');
        case 'running':
            // Desktop's `background` activity: the turn ended while work it started still runs.
            return t(
                session.primaryTerminal?.agentOperation === 'background'
                    ? 'sessions.state.background'
                    : 'sessions.state.working',
            );
        case 'failed':
            return t('sessions.state.failed');
        case 'completed':
            return t('sessions.state.completed');
        case 'idle':
            return t('sessions.state.idle');
        case 'unknown':
            return t('sessions.state.unknown');
    }
};

/**
 * The phone mirrors Desktop's status projection from the fields it receives: a running turn reads `running`, and a
 * Terminal handed over to another client reads `detached`. The home list is the phone's only Session list, so a
 * finished Session past the retention window moves to Idle instead of leaving it as it leaves Desktop's Activity view.
 */
const groupForSession = (session: MobileSession, now: number): SessionActivityGroupId =>
    sessionActivityGroup(
        {
            ...session,
            // A Chat waiting for a plan limit to reset outranks unread attention, as on Desktop (`sessionStatus`).
            hasUnread: session.hasUnread && session.primaryTerminal?.usageLimitWaitAt === undefined,
            isUsageWaiting: session.primaryTerminal?.usageLimitWaitAt !== undefined,
            isDetached: session.primaryTerminal?.lastProcessState === 'detached',
            isRunning: session.agentActivityState === 'running',
        },
        now,
    ) ?? 'idle';

export const buildMobileSessionSections = (
    input: {
        sessions: MobileSession[];
        total: number;
        truncated: boolean;
    },
    t: Translate = translate,
    now = Date.now(),
): MobileSessionSections => {
    const groups = emptyMobileSessionGroups();
    for (const session of input.sessions) {
        const group = groupForSession(session, now);
        const item: MobileSessionItem = {
            ...session,
            group,
            stateLabel: session.primaryTerminal?.usageLimitWaitAt
                ? t('sessions.state.usageWait', {
                      time: resetClockTime(
                          session.primaryTerminal.usageLimitWaitAt,
                          now,
                          getLocale(),
                      ),
                  })
                : labelForState(session, t),
        };
        // Desktop repeats a pinned Session that has news under its status group; the phone lists each Session once
        // (no duplicate entries to the same data), and the row's status glyph still shows the state under Pinned.
        if (isPinnedSession(session)) groups.pinned.push(item);
        else groups[group].push(item);
    }
    groups.pinned.sort(compareSessionPinnedOrder);
    for (const group of SESSION_ACTIVITY_GROUP_ORDER)
        groups[group].sort(compareSessionActivityGroupRows);
    const seen = new Set<string>();
    const sessions = MOBILE_SESSION_LIST_GROUPS.flatMap((group) => groups[group]).filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    });
    return { groups, sessions, total: input.total, truncated: input.truncated };
};

export const isMobileTerminalStopped = (session: MobileSessionItem): boolean => {
    switch (session.primaryTerminal?.lastProcessState) {
        case 'stopped':
        case 'dead':
        case 'failed':
        case 'interrupted':
        case 'suspended':
        case 'detached':
            return true;
        case 'running':
        case 'starting':
        case undefined:
            return false;
    }
};
