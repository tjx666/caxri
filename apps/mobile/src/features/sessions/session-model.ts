import type {
    MethodResult,
    MobileDashboardResult,
    MobileDeviceRole,
    SessionActivityGroupId,
} from '@caxri/protocol';
import {
    compareSessionActivityGroupRows,
    compareSessionPinnedOrder,
    isPinnedSession,
    isSessionAgentRunning,
    MOBILE_DASHBOARD_GROUPS,
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
 * `session-activity-group.ts` in `@caxri/protocol`), so a Session sits under the same heading on both. The Server pages
 * the dashboard by the same groups.
 */
export const MOBILE_SESSION_LIST_GROUPS = MOBILE_DASHBOARD_GROUPS;

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
    /**
     * Each group's rows on the Server, including the ones the phone has not loaded yet.
     */
    groupTotals: MobileDashboardResult['groupTotals'];
    total: number;
    truncated: boolean;
}

export const emptyMobileGroupTotals = (): MobileDashboardResult['groupTotals'] => ({
    pinned: 0,
    attention: 0,
    working: 0,
    idle: 0,
});

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
 * Archive. An empty list means the row does not swipe.
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
 * The home list section a Session is listed under: Pinned for a pinned Session, otherwise its status group. The Server
 * pages the dashboard by the same rule, so a group's rows on the phone are a prefix of the Server's.
 */
export const mobileSessionListGroup = (session: MobileSession): MobileSessionListGroup =>
    isPinnedSession(session) ? 'pinned' : groupForSession(session);

export const buildMobileSessionSections = (
    input: {
        groupTotals?: MobileDashboardResult['groupTotals'];
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
    return {
        groups,
        groupTotals: input.groupTotals ?? {
            pinned: groups.pinned.length,
            attention: groups.attention.length,
            working: groups.working.length,
            idle: groups.idle.length,
        },
        sessions,
        total: input.total,
        truncated: input.truncated,
    };
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
