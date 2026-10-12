import type { CommanderConversationReference } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { queryClient } from '../../queries/client';
import { pushToast, tryCommand } from '../../stores/toasts';
import type { HandoverSummary } from './commander-handover';
import { handoverRejectionLabelKeys, summarizeHandover } from './commander-handover';

/**
 * Reads that change when a Session joins or leaves the Commander: the board's ownership marks, the Workbench's managed
 * set, and the conversation list, which drops a conversation once a Caxri Terminal binds it.
 */
async function invalidateHandoverReads(): Promise<void> {
    await Promise.all(
        (['commander.board', 'commander.managedSessions', 'commander.conversations'] as const).map(
            (method) => queryClient.invalidateQueries({ queryKey: [method] }),
        ),
    );
}

export interface HandoverSubmission {
    sessionIds: string[];
    conversations: CommanderConversationReference[];
    note?: string;
}

/**
 * Hands the selection to the Commander and reports the outcome as one toast. From the Workbench (`isFromWorkbench`) the
 * Commander is created first if the user never opened it, and the toast offers to open its window; inside that window
 * there is nothing to open. Returns the summary so the dialog can keep refused entries in view, or undefined when the
 * request itself failed (already reported).
 */
export async function handOverToCommander(
    submission: HandoverSubmission,
    { isFromWorkbench }: { isFromWorkbench: boolean },
): Promise<HandoverSummary | undefined> {
    const note = submission.note?.trim();
    const summary = await tryCommand(
        translate('agentCommander.handover.failed'),
        async () => {
            if (isFromWorkbench) await caxri.request('commander.ensure');
            return summarizeHandover(
                await caxri.request('commander.session.handOver', {
                    sessionIds: submission.sessionIds,
                    conversations: submission.conversations,
                    ...(note && { note }),
                }),
            );
        },
        { refresh: invalidateHandoverReads },
    );
    if (summary) reportHandover(summary, isFromWorkbench);
    return summary;
}

function reportHandover(summary: HandoverSummary, isFromWorkbench: boolean): void {
    const refused = summary.rejected.reduce((total, entry) => total + entry.count, 0);
    if (summary.accepted === 0) {
        pushToast(
            'error',
            translate('agentCommander.handover.noneAccepted', {
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
            ? translate('agentCommander.handover.partlyAccepted', {
                  accepted: summary.accepted,
                  refused,
              })
            : translate(
                  summary.accepted === 1
                      ? 'agentCommander.handover.acceptedOne'
                      : 'agentCommander.handover.acceptedOther',
                  { count: summary.accepted },
              ),
        isFromWorkbench ? { action: { id: 'agentCommander.open' } } : undefined,
    );
}

/**
 * Takes one Session back from the Commander. Its Agents keep running; only the Commander's right to work there ends.
 */
export function takeBackFromCommander(sessionId: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports a failed take-back through a toast
    void tryCommand(
        translate('agentCommander.handover.takeBackFailed'),
        () => caxri.request('commander.session.takeBack', { sessionId }),
        { refresh: invalidateHandoverReads },
    ).then((result) => {
        if (result?.outcome === 'taken_back')
            pushToast('success', translate('agentCommander.handover.takenBack'));
    });
}
