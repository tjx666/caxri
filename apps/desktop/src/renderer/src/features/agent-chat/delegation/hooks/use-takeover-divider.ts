import { useMemo } from 'react';

import type { AgentChatTimelineEntry } from '../../transcript/agent-chat-timeline';
import type { ControlDividerPlacements } from '../agent-chat-takeover-divider';
import { controlDividerPlacements, NO_CONTROL_DIVIDERS } from '../agent-chat-takeover-divider';
import { useDelegationOrigin } from './use-delegation-origin';

/**
 * Where this Chat's live timeline shows a divider for each time the Session changed hands ("You took over", "Handed
 * back to ..."), and the delegating Session's title the hand-back dividers name. No dividers while the Session never
 * changed hands or is not a delegated child. `isHistoryComplete` is false while earlier history exists that this pane
 * has not read back, so a change that may sit in it is not pinned to the first live entry.
 */
export function useTakeoverDivider(
    terminalId: string,
    timeline: readonly AgentChatTimelineEntry[],
    isHistoryComplete: boolean,
): { parentTitle: string; placements: ControlDividerPlacements } {
    const { controlChanges, origin } = useDelegationOrigin(terminalId);
    const placements = useMemo(
        () =>
            controlChanges === undefined
                ? NO_CONTROL_DIVIDERS
                : controlDividerPlacements(timeline, controlChanges, isHistoryComplete),
        [timeline, controlChanges, isHistoryComplete],
    );
    return { parentTitle: origin?.parent.title ?? '', placements };
}
