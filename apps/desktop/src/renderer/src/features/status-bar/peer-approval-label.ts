export interface PeerApprovalChipCopy {
    /**
     * The chip's visible text, short enough for the actions rail.
     */
    text: string;
    /**
     * Accessible name and tooltip: the same count as a full sentence, plus what a click does.
     */
    description: string;
}

/**
 * Copy for the status bar's count of peer messages the user set aside with "Decide later", or undefined when none are
 * waiting: the chip exists only while a sender is still waiting on the user's answer.
 */
export function peerApprovalChipCopy(deferredCount: number): PeerApprovalChipCopy | undefined {
    if (deferredCount < 1) return undefined;
    const isSingle = deferredCount === 1;
    const noun = isSingle ? 'message' : 'messages';
    return {
        text: `${deferredCount} ${noun} awaiting approval`,
        description: `${deferredCount} peer ${noun} ${isSingle ? 'is' : 'are'} waiting for your approval. Click to review the oldest one.`,
    };
}
