import type { AgentChatContinuationTarget, AgentProvider } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { tryCommand } from '../../../stores/toasts';
import { openSession } from '../../session/session-commands';

/**
 * Where a continuation starts: the failed turn's usage-limit card, the usage guard's "Open in another Agent", or the
 * user's Continue in Another Agent from a tab or Session menu.
 */
export type AgentChatContinueOrigin = 'usageGuard' | 'manual' | { turnId: string };

/**
 * Continues the Chat's work in a new Session with `provider` (`agentChat.continueInAgent`) and opens that Session. A
 * failure is a toast, and resolves like a success so the caller only clears its pending state.
 */
export async function continueAgentChatInAgent(
    terminalId: string,
    provider: AgentProvider,
    origin: AgentChatContinueOrigin,
): Promise<void> {
    const result = await tryCommand(translate('agentChat.usageLimit.continueFailed'), () =>
        caxri.request('agentChat.continueInAgent', {
            terminalId,
            provider,
            ...(origin === 'manual' && { manual: true }),
            ...(typeof origin === 'object' && { turnId: origin.turnId }),
        }),
    );
    if (result) openSession(result.sessionId);
}

/**
 * The providers that could take this Chat's work over, for a menu built when it opens. A failed read is an empty list,
 * which the menu shows as "no other Agent", instead of failing the whole menu.
 */
export async function readAgentChatContinuationTargets(
    terminalId: string,
): Promise<readonly AgentChatContinuationTarget[]> {
    try {
        return (await caxri.request('agentChat.continuationTargets', { terminalId })).targets;
    } catch {
        return [];
    }
}

/**
 * Spends the usage guard's one hand-off on this Chat (`agentChat.generateHandoff`). The document arrives on the
 * snapshot's `usageGuard`, so nothing is returned.
 */
export async function generateAgentChatHandoff(terminalId: string): Promise<void> {
    await tryCommand(translate('agentChat.usageGuard.generateFailed'), () =>
        caxri.request('agentChat.generateHandoff', { terminalId }),
    );
}

/**
 * Admits the account's requests for the rest of the guard's window (`agentChat.bypassUsageGuard`). The card leaves with
 * the guard on the snapshot, so nothing is returned.
 */
export async function bypassAgentChatUsageGuard(terminalId: string): Promise<void> {
    await tryCommand(translate('agentChat.usageGuard.continueAnywayFailed'), () =>
        caxri.request('agentChat.bypassUsageGuard', { terminalId }),
    );
}

/**
 * Ends the Chat's wait for the limit to reset (`cancel`), or continues it now (`continueNow`). A failure is a toast;
 * the notice follows the Chat's projection either way.
 */
export async function answerAgentChatUsageLimitWait(
    terminalId: string,
    turnId: string,
    action: 'cancel' | 'continueNow',
): Promise<void> {
    await tryCommand(
        translate(
            action === 'cancel'
                ? 'agentChat.usageLimit.auto.cancelFailed'
                : 'agentChat.usageLimit.auto.continueFailed',
        ),
        () => caxri.request('agentChat.usageLimitWait', { terminalId, turnId, action }),
    );
}
