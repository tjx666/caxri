import type { AgentChatSnapshot, ProcessState } from '@caxri/protocol';

import type { Translate } from '../../../../i18n';
import { translate } from '../../../../i18n';

/**
 * One line of the Send button's tooltip while a turn runs: what a key does, beside its keycap.
 */
export interface AgentChatSendKey {
    label: string;
    shortcut: string;
}

/**
 * Why the Chat itself refuses a message right now (`canSendAgentChatMessage`), or `undefined` when it accepts one.
 */
export function agentChatSendBlock(
    snapshot: Pick<AgentChatSnapshot, 'status'> | undefined,
    processState: ProcessState | undefined,
): 'detached' | 'failed' | 'loading' | undefined {
    if (processState === 'detached') return 'detached';
    if (!snapshot) return 'loading';
    return snapshot.status === 'failed' ? 'failed' : undefined;
}

/**
 * The Send button's tooltip: what it does, or, while it is disabled, why, so a dead button never leaves the user
 * guessing. The Chat's own refusal wins over the composer's state, since no draft or image fixes it.
 */
export function agentChatSendTooltip(
    action: { tooltip: string },
    state: {
        block: ReturnType<typeof agentChatSendBlock>;
        hasContent: boolean;
        isAttaching: boolean;
        /**
         * A Session chosen from the `@` list is being condensed into a reference file.
         */
        isPreparingReference?: boolean;
        isSending: boolean;
    },
    t: Translate = translate,
): string {
    return sendBlockedReason(state, t) ?? action.tooltip;
}

/**
 * The keycap the Send button's tooltip shows beside {@link agentChatSendTooltip}'s text: the action's shortcut while
 * Send can act, and none while the tooltip explains why it cannot, where a key would promise a press that does
 * nothing.
 */
export function agentChatSendTooltipShortcut(
    action: { shortcut?: string; tooltip: string },
    state: Parameters<typeof agentChatSendTooltip>[1],
): string | undefined {
    return sendBlockedReason(state, translate) === undefined ? action.shortcut : undefined;
}

/**
 * The key list the Send button's tooltip shows in place of {@link agentChatSendTooltip}'s text while a turn runs, and
 * none while the tooltip explains why Send cannot act.
 */
export function agentChatSendTooltipKeys(
    action: { keys?: readonly AgentChatSendKey[]; tooltip: string },
    state: Parameters<typeof agentChatSendTooltip>[1],
): readonly AgentChatSendKey[] | undefined {
    return sendBlockedReason(state, translate) === undefined ? action.keys : undefined;
}

function sendBlockedReason(
    state: Parameters<typeof agentChatSendTooltip>[1],
    t: Translate,
): string | undefined {
    switch (state.block) {
        case 'loading': {
            return t('agentChat.message.sendBlockedLoading');
        }
        case 'failed': {
            return t('agentChat.message.sendBlockedFailed');
        }
        case 'detached': {
            return t('agentChat.message.sendBlockedDetached');
        }
        case undefined: {
            break;
        }
    }
    if (state.isPreparingReference) return t('agentChat.message.preparingReference');
    if (state.isAttaching) return t('agentChat.message.attaching');
    if (state.isSending) return t('agentChat.message.sending');
    if (!state.hasContent) return t('agentChat.message.typeToSend');
    return undefined;
}
