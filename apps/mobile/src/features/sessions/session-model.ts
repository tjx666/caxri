import type { MethodResult } from '@caxri/protocol';
import { compareSessionActivityRecency } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

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

export const buildMobileSessionSections = (
    input: {
        sessions: MobileSession[];
        total: number;
        truncated: boolean;
    },
    t: Translate = translate,
): MobileSessionSections => {
    const result: MobileSessionSections = {
        needsAttention: [],
        running: [],
        recent: [],
        total: input.total,
        truncated: input.truncated,
    };
    const active = [...input.sessions];
    active.sort(compareSessionActivityRecency);
    for (const session of active) {
        const group = groupForSession(session);
        const item: MobileSessionItem = {
            ...session,
            group,
            stateLabel: labelForState(session.lastActivityState, t),
        };
        if (group === 'needs-attention') result.needsAttention.push(item);
        else if (group === 'running') result.running.push(item);
        else result.recent.push(item);
    }
    result.needsAttention.sort(
        (left, right) =>
            Number(right.hasUnread) - Number(left.hasUnread) ||
            compareSessionActivityRecency(left, right),
    );
    return result;
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
