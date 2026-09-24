import type { MethodResult } from '@caxri/protocol';

export type MobileSession = MethodResult<'mobile.dashboard'>['sessions'][number];
export type MobileTerminal = NonNullable<MobileSession['primaryTerminal']>;

type MobileSessionGroup = 'needs-attention' | 'recent' | 'running';

export interface MobileSessionItem extends MobileSession {
    group: MobileSessionGroup;
    primaryTerminal?: MobileTerminal;
    projectTitle: string;
    stateLabel: string;
}

export interface MobileSessionSections {
    needsAttention: MobileSessionItem[];
    recent: MobileSessionItem[];
    running: MobileSessionItem[];
    total: number;
    truncated: boolean;
}

const labelForState = (state: MobileSession['lastActivityState']): string => {
    switch (state) {
        case 'waiting':
            return 'Waiting for you';
        case 'running':
            return 'Working';
        case 'failed':
            return 'Failed';
        case 'completed':
            return 'Completed';
        case 'idle':
            return 'Idle';
        case 'unknown':
            return 'Unknown';
    }
};

const groupForSession = (session: MobileSession): MobileSessionGroup => {
    if (
        session.hasUnread ||
        session.lastActivityState === 'waiting' ||
        session.lastActivityState === 'failed'
    )
        return 'needs-attention';
    if (session.lastActivityState === 'running') return 'running';
    return 'recent';
};

export const buildMobileSessionSections = (input: {
    sessions: MobileSession[];
    total: number;
    truncated: boolean;
}): MobileSessionSections => {
    const result: MobileSessionSections = {
        needsAttention: [],
        running: [],
        recent: [],
        total: input.total,
        truncated: input.truncated,
    };
    const active = [...input.sessions];
    active.sort(
        (left, right) => right.lastOpenedAt - left.lastOpenedAt || left.id.localeCompare(right.id),
    );
    for (const session of active) {
        const group = groupForSession(session);
        const item: MobileSessionItem = {
            ...session,
            group,
            stateLabel: labelForState(session.lastActivityState),
        };
        if (group === 'needs-attention') result.needsAttention.push(item);
        else if (group === 'running') result.running.push(item);
        else result.recent.push(item);
    }
    result.needsAttention.sort(
        (left, right) =>
            Number(right.hasUnread) - Number(left.hasUnread) ||
            right.lastOpenedAt - left.lastOpenedAt ||
            left.id.localeCompare(right.id),
    );
    return result;
};

export const shortReplyDisabledReason = (
    session: MobileSessionItem,
    isConnected: boolean,
): string | null => {
    if (!isConnected) return 'Reconnect to Caxri before replying.';
    if (session.lastActivityState !== 'waiting')
        return 'Replies are available only while the Agent is waiting for you.';
    if (!session.primaryAgentTerminalId || !session.primaryTerminal)
        return 'This Session has no available primary Agent.';
    return null;
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

export const mobileSessionDraftKey = (session: MobileSession): string =>
    `${session.id}:${session.primaryAgentTerminalId ?? 'none'}:${session.attentionEpoch}`;
