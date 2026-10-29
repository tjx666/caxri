import type { Translate } from '../../i18n';

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
export function peerApprovalChipCopy(
    deferredCount: number,
    t: Translate,
): PeerApprovalChipCopy | undefined {
    if (deferredCount < 1) return undefined;
    const parameters = { count: deferredCount };
    return deferredCount === 1
        ? {
              text: t('statusBar.peerApproval.textOne', parameters),
              description: t('statusBar.peerApproval.descriptionOne', parameters),
          }
        : {
              text: t('statusBar.peerApproval.textOther', parameters),
              description: t('statusBar.peerApproval.descriptionOther', parameters),
          };
}
