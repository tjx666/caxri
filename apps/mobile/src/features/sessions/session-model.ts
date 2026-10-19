import type { MethodResult, SessionActivityGroupId } from '@caxri/protocol';
import {
    compareSessionActivityGroupRows,
    compareSessionPinnedOrder,
    isPinnedSession,
    PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS,
    SESSION_ACTIVITY_GROUP_ORDER,
    sessionActivityGroup,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

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
     * The Session's status group. A pinned Session also has one; it decides whether the Session is listed a second time
     * below Pinned.
     */
    group: SessionActivityGroupId;
    primaryTerminal?: MobileTerminal;
    projectTitle: string;
    stateLabel: string;
}

export interface MobileSessionSections {
    groups: Record<MobileSessionListGroup, MobileSessionItem[]>;
    /**
     * Every Session once, in list order: a pinned Session listed again in its status group is not repeated here.
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

const labelForState = (state: MobileSession['lastActivityState'], t: Translate): string => {
    switch (state) {
        case 'waiting':
            return t('sessions.state.waiting');
        case 'running':
            return t('sessions.state.working');
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
            isDetached: session.primaryTerminal?.lastProcessState === 'detached',
            isRunning: session.lastActivityState === 'running',
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
            stateLabel: labelForState(session.lastActivityState, t),
        };
        if (isPinnedSession(session)) {
            groups.pinned.push(item);
            if (PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS.has(group)) groups[group].push(item);
        } else groups[group].push(item);
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
