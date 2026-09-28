import { Inbox } from 'lucide-react';

import {
    reviewOldestDeferredMessage,
    selectDeferredHeldMessageCount,
    useHeldMessageQueueStore,
} from '../agent-inbox/agent-message-approval-store';
import { peerApprovalChipCopy } from './peer-approval-label';
import { StatusItem } from './status-item';

/**
 * How many peer messages the user set aside with "Decide later" and has not answered. Each sender is still waiting, so
 * the count stays on screen until the last one is approved, denied, or expires, and a click reopens the one that has
 * waited longest. It keeps the default foreground rather than a warning tone: a request waiting on the user's decision
 * is not a failure (DESIGN.md status bar redline).
 */
export function PeerApprovalChip() {
    const count = useHeldMessageQueueStore(selectDeferredHeldMessageCount);
    const copy = peerApprovalChipCopy(count);
    if (!copy) return null;
    return (
        <StatusItem
            icon={<Inbox />}
            ariaLabel={copy.description}
            title={copy.description}
            className="statusbar-peer-approval"
            onClick={reviewOldestDeferredMessage}
        >
            {copy.text}
        </StatusItem>
    );
}
