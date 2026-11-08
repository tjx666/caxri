import type { MethodResult, MobileDeviceRole, SessionActivityGroupId } from '@caxri/protocol';
import {
    compareSessionActivityGroupRows,
    compareSessionPinnedOrder,
    isPinnedSession,
    isSessionAgentRunning,
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
 * Terminal handed over to another client reads `detached`. Pending Attention stays in Needs attention until the user
 * marks it done, so the group needs no clock.
 */
const groupForSession = (session: MobileSession): SessionActivityGroupId =>
    sessionActivityGroup({
        hasPendingAttention: session.hasPendingAttention,
        isUsageWaiting: session.primaryTerminal?.usageLimitWaitAt !== undefined,
        isDetached: session.primaryTerminal?.lastProcessState === 'detached',
        isRunning: isSessionAgentRunning(session, session.primaryTerminal),
    });

/**
 * Whether a Session shows the Mark as Done action: only a Session with Pending Attention has something to resolve.
 */
export const canMarkSessionDone = (session: Pick<MobileSession, 'hasPendingAttention'>): boolean =>
    session.hasPendingAttention;

/**
 * Whether a Session row offers Mark as Done, the phone's counterpart of the check on a Desktop Activity Needs attention
 * row. It needs Pending Attention to resolve, a live list (a saved copy's attention generation may already be stale),
 * and a device granted `session.markDone`, which only the reply and control roles carry.
 */
export const canMarkDoneFromRow = (
    session: Pick<MobileSession, 'hasPendingAttention'>,
    deviceRole: MobileDeviceRole | null,
    isSaved: boolean,
): boolean =>
    !isSaved && (deviceRole === 'reply' || deviceRole === 'control') && canMarkSessionDone(session);

export type SessionRowSwipeAction = 'archive' | 'markDone';

/**
 * The actions a left swipe on a Session row reveals, in order from the row toward the trailing edge. Mark as Done
 * follows `canMarkDoneFromRow`; Archive needs a live list and the control role, the same gate as the long-press sheet's
 * Archive. An empty list means the row does not swipe, so the drag stays with the Project pager.
 */
export const sessionRowSwipeActions = (
    session: Pick<MobileSession, 'hasPendingAttention'>,
    deviceRole: MobileDeviceRole | null,
    isSaved: boolean,
): SessionRowSwipeAction[] => [
    ...(canMarkDoneFromRow(session, deviceRole, isSaved) ? (['markDone'] as const) : []),
    ...(!isSaved && deviceRole === 'control' ? (['archive'] as const) : []),
];

const orderFacts = (session: MobileSession) => ({
    attentionResolvedAt: session.attentionResolvedAt,
    id: session.id,
    lastAttentionKind: session.lastAttentionKind,
    sessionActivityAt: session.sessionActivityAt,
    turnStartedAt: session.turnStartedAt,
});

/**
 * The shared group comparator applied to a mobile row, with the two caches the phone can read off the dashboard.
 */
const compareMobileSessionRows =
    (group: SessionActivityGroupId) =>
    (left: MobileSessionItem, right: MobileSessionItem): number =>
        compareSessionActivityGroupRows(group, orderFacts(left), orderFacts(right));

/**
 * Whether the home list gives a Session a row. The phone has no room for Desktop's nested rows under the Session that
 * created another, so it leaves that work out instead: a `consult` Session (a second opinion) or an unpinned
 * `delegated` one whose creator the list holds belongs to the creator, and the creator's timeline still links to it. A
 * Session whose creator is absent (deleted, archived, or past the dashboard cap) keeps its row so nothing becomes
 * unreachable, and so does one waiting on the user's answer, which the phone must not hide.
 */
export const isSessionListedOnHome = (
    session: Pick<
        MobileSession,
        | 'agentActivityState'
        | 'createdByRelation'
        | 'createdBySessionId'
        | 'hasPendingAttention'
        | 'lastAttentionKind'
        | 'pinnedAt'
    >,
    listedSessionIds: ReadonlySet<string>,
): boolean => {
    const creatorId = session.createdBySessionId;
    if (creatorId === undefined || !listedSessionIds.has(creatorId)) return true;
    const isCreatorWork =
        session.createdByRelation === 'consult' ||
        (session.createdByRelation === 'delegated' && !isPinnedSession(session));
    if (!isCreatorWork) return true;
    return (
        session.agentActivityState === 'waiting' ||
        (session.hasPendingAttention && session.lastAttentionKind === 'waiting')
    );
};

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
        const group = groupForSession(session);
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
        groups[group].sort(compareMobileSessionRows(group));
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
