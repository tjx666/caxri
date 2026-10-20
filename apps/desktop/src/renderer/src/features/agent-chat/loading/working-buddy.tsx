import type { AgentChatActivity } from '@caxri/protocol';

import { Buddy } from './buddy';
import { buddyMood, buddyTiredAt, isBuddyPartyTurn } from './presentation';
import { useIsPast } from './use-is-past';

/**
 * Buddy driven by the Chat's activity: it acts out the running tool, tires once one tool runs past
 * `BUDDY_TIRED_AFTER_MS`, and wears the turn's party hat when it has one.
 */
export function WorkingBuddy({
    activity,
    size,
    turnId,
}: {
    activity: AgentChatActivity | undefined;
    size?: number;
    turnId: string | undefined;
}) {
    const isTired = useIsPast(buddyTiredAt(activity));
    return (
        <Buddy
            isParty={isBuddyPartyTurn(turnId)}
            mood={isTired ? 'tired' : buddyMood(activity)}
            size={size}
        />
    );
}
