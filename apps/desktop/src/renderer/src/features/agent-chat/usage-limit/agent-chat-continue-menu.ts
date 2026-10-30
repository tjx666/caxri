import type { AgentChatContinuationTarget, TerminalRecord } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import { translate } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import type { ContextMenuEntry } from '../../../lib/context-menu';
import { chatConversationBlocker } from '../../session/session-agent-commands';
import {
    agentChatContinuationChoice,
    agentChatContinuationUnavailableLabel,
} from './agent-chat-continuation';
import {
    continueAgentChatInAgent,
    readAgentChatContinuationTargets,
} from './agent-chat-usage-limit-commands';

type ContinueMenuTerminal = Pick<TerminalRecord, 'agentSessionId' | 'id' | 'provider' | 'surface'>;

const DISABLED = (): void => {};

/**
 * The "Continue in Another Agent" submenu of a Chat tab or a Session row, built from the targets Server Core reported:
 * one entry per other provider, the unavailable ones disabled with their reason, as the usage-limit card's menu lists
 * them. It is the same continuation without a limit, so it needs an Agent open as Chat that already has a conversation.
 * A running turn is left to Server Core, which refuses it with the reason. A Shell has no Agent to continue, so it gets
 * no entry. A blocked entry is a disabled item rather than a submenu, because a submenu without children never reaches
 * the native menu.
 */
export function agentChatContinueMenuEntry(
    terminal: ContinueMenuTerminal,
    targets: readonly AgentChatContinuationTarget[],
    now: number,
    t: Translate,
): ContextMenuEntry | undefined {
    const blocker = chatConversationBlocker(terminal);
    if (blocker === 'noAgent') return undefined;
    const label = t('agentChat.continueMenu.label');
    if (blocker)
        return {
            label,
            onSelect: DISABLED,
            disabled: true,
            disabledReason: t(
                blocker === 'notChat'
                    ? 'agentChat.continueMenu.needsChatReason'
                    : 'agentChat.continueMenu.noConversationReason',
            ),
        };
    const choices = agentChatContinuationChoice(targets).targets;
    if (choices.length === 0)
        return {
            label,
            onSelect: DISABLED,
            disabled: true,
            disabledReason: t('agentChat.usageLimit.noTarget'),
        };
    return {
        type: 'submenu',
        label,
        entries: choices.map((target) => {
            const reason = agentChatContinuationUnavailableLabel(target, now, t);
            return {
                label: resolveAgentIcon(target.provider).label,
                disabled: reason !== undefined,
                disabledReason: reason,
                onSelect: () => continueAgentChatInAgent(terminal.id, target.provider, 'manual'),
            };
        }),
    };
}

/**
 * Reads the targets when the menu opens and builds {@link agentChatContinueMenuEntry}.
 */
export async function readAgentChatContinueMenuEntry(
    terminal: ContinueMenuTerminal | undefined,
): Promise<ContextMenuEntry | undefined> {
    if (!terminal) return undefined;
    const targets =
        chatConversationBlocker(terminal) === undefined
            ? await readAgentChatContinuationTargets(terminal.id)
            : [];
    return agentChatContinueMenuEntry(terminal, targets, Date.now(), translate);
}
