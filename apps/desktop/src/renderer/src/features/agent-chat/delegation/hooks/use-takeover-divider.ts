import { useMemo } from 'react';

import type { AgentChatTimelineEntry } from '../../transcript/agent-chat-timeline';
import type { TakeoverDividerPlacement } from '../agent-chat-takeover-divider';
import { takeoverDividerPlacement } from '../agent-chat-takeover-divider';
import { useDelegationOrigin } from './use-delegation-origin';

/**
 * Where the "You took over" divider goes in this Chat's live timeline, or `undefined` while the user has not taken the
 * Session over (or this is not a delegated child). `isHistoryComplete` is false while earlier history exists that this
 * pane has not read back, so a takeover that may sit in it is not pinned to the first live entry.
 */
export function useTakeoverDivider(
    terminalId: string,
    timeline: readonly AgentChatTimelineEntry[],
    isHistoryComplete: boolean,
): TakeoverDividerPlacement | undefined {
    const { takenOverAt } = useDelegationOrigin(terminalId);
    return useMemo(
        () =>
            takenOverAt === undefined
                ? undefined
                : takeoverDividerPlacement(timeline, takenOverAt, isHistoryComplete),
        [timeline, takenOverAt, isHistoryComplete],
    );
}
