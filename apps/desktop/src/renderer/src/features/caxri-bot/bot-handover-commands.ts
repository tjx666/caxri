import type { BotConversationReference } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { queryClient } from '../../queries/client';
import { pushToast, tryCommand } from '../../stores/toasts';
import type { HandoverSummary } from './bot-handover';
import { handoverRejectionLabelKeys, summarizeHandover } from './bot-handover';

/**
 * Reads that change when a Session joins or leaves Caxri Bot: the board's ownership marks, the Workbench's managed set,
 * and the conversation list, which drops a conversation once a Caxri Terminal binds it.
 */
async function invalidateHandoverReads(): Promise<void> {
    await Promise.all(
        (['bot.board', 'bot.managedSessions', 'bot.conversations'] as const).map((method) =>
            queryClient.invalidateQueries({ queryKey: [method] }),
        ),
    );
}

export interface HandoverSubmission {
    sessionIds: string[];
    conversations: BotConversationReference[];
    note?: string;
}

/**
 * Hands the selection to Caxri Bot and reports the outcome as one toast. From the Workbench (`isFromWorkbench`) the
 * Caxri Bot is created first if the user never opened it, and the toast offers to open its window; inside that window
 * there is nothing to open. Returns the summary so the dialog can keep refused entries in view, or undefined when the
 * request itself failed (already reported).
 *
 * `isReportedInPlace` is asked once the answer arrives: while the dialog that sent the request is still open, it shows
 * refusals on the rows themselves, and DESIGN.md's Toasts rule keeps a failure the dialog reports in place out of the
 * toast channel. A full success closes the dialog, so it is always a toast; so is any outcome the user closed the
 * dialog before seeing.
 */
export async function handOverToBot(
    submission: HandoverSubmission,
    {
        isFromWorkbench,
        isReportedInPlace,
    }: { isFromWorkbench: boolean; isReportedInPlace?: () => boolean },
): Promise<HandoverSummary | undefined> {
    const note = submission.note?.trim();
    const summary = await tryCommand(
        translate('caxriBot.handover.failed'),
        async () => {
            if (isFromWorkbench) await caxri.request('bot.ensure');
            return summarizeHandover(
                await caxri.request('bot.session.handOver', {
                    sessionIds: submission.sessionIds,
                    conversations: submission.conversations,
                    ...(note && { note }),
                }),
            );
        },
        { refresh: invalidateHandoverReads },
    );
    if (summary && !(summary.rejected.length > 0 && isReportedInPlace?.()))
        reportHandover(summary, isFromWorkbench);
    return summary;
}

function reportHandover(summary: HandoverSummary, isFromWorkbench: boolean): void {
    const refused = summary.rejected.reduce((total, entry) => total + entry.count, 0);
    if (summary.accepted === 0) {
        pushToast(
            'error',
            translate('caxriBot.handover.noneAccepted', {
                reason: translate(
                    handoverRejectionLabelKeys[summary.rejected[0]?.reason ?? 'session_missing'],
                ),
            }),
        );
        return;
    }
    pushToast(
        refused > 0 ? 'warning' : 'success',
        refused > 0
            ? translate('caxriBot.handover.partlyAccepted', {
                  accepted: summary.accepted,
                  refused,
              })
            : translate(
                  summary.accepted === 1
                      ? 'caxriBot.handover.acceptedOne'
                      : 'caxriBot.handover.acceptedOther',
                  { count: summary.accepted },
              ),
        isFromWorkbench ? { action: { id: 'caxriBot.open' } } : undefined,
    );
}

/**
 * Takes one Session back from Caxri Bot. Its Agents keep running; only Caxri Bot's right to work there ends.
 */
export function takeBackFromBot(sessionId: string): void {
    void tryCommand(
        translate('caxriBot.handover.takeBackFailed'),
        () => caxri.request('bot.session.takeBack', { sessionId }),
        { refresh: invalidateHandoverReads },
    ).then((result) => {
        if (result?.outcome === 'taken_back')
            pushToast('success', translate('caxriBot.handover.takenBack'));
    });
}
