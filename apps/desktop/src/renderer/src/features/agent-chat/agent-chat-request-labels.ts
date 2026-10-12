import type {
    AgentChatApprovalDecision,
    AgentChatApprovalRequest,
    AgentChatFailureReason,
    AgentChatRequest,
    AgentToolKind,
} from '@caxri/protocol';
import {
    AGENT_CHAT_EXIT_PLAN_TOOL,
    agentChatApprovalChoices,
    describeAgentTool,
    isAgentChatApprovalRequest,
} from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

/**
 * Localized counterparts of `@caxri/protocol`'s Agent Chat request copy (`agentChatApprovalChoices` labels,
 * `agentChatRequestTitle`, `agentChatWaitingText`, and the Desktop `agentChatFailureMessage`). The protocol versions
 * stay English because the phone and the CLI share them; these follow the same rules so English output is
 * byte-identical.
 */

/**
 * A tool subject longer than this stays out of the approval title; the card shows it in full below. Mirrors the
 * protocol's `REQUEST_TITLE_SUBJECT_LENGTH`.
 */
const REQUEST_TITLE_SUBJECT_LENGTH = 60;

function acceptLabelKey(request: AgentChatApprovalRequest): TranslationKey {
    switch (request.kind) {
        case 'command': {
            return request.networkHost ? 'agentChat.approval.allow' : 'agentChat.approval.run';
        }
        case 'fileChange': {
            return 'agentChat.approval.applyChanges';
        }
        case 'tool': {
            return request.name === AGENT_CHAT_EXIT_PLAN_TOOL
                ? 'agentChat.approval.startBuilding'
                : 'agentChat.approval.allow';
        }
    }
}

function choiceLabelKey(
    request: AgentChatApprovalRequest,
    decision: AgentChatApprovalDecision,
): TranslationKey {
    switch (decision) {
        case 'accept': {
            return acceptLabelKey(request);
        }
        case 'acceptForSession': {
            return 'agentChat.approval.alwaysAllow';
        }
        case 'decline': {
            return request.kind === 'tool' && request.name === AGENT_CHAT_EXIT_PLAN_TOOL
                ? 'agentChat.approval.keepPlanning'
                : 'agentChat.approval.deny';
        }
    }
}

/**
 * The approval buttons to show, in the protocol's order and filtered by the provider's `decisions`, each labeled by its
 * outcome in the interface language.
 */
export function agentChatLocalizedApprovalChoices(
    request: AgentChatApprovalRequest,
    t: Translate = translate,
): Array<{ decision: AgentChatApprovalDecision; label: string }> {
    return agentChatApprovalChoices(request).map(({ decision }) => ({
        decision,
        label: t(choiceLabelKey(request, decision)),
    }));
}

type AgentToolActionKind = Exclude<AgentToolKind, 'mcp' | 'other'>;

const isActionKind = (kind: AgentToolKind): kind is AgentToolActionKind =>
    kind !== 'mcp' && kind !== 'other';

function toolRequestTitle(request: { name: string; summary?: string }, t: Translate): string {
    const presentation = describeAgentTool(request);
    if (presentation.kind === 'mcp' && presentation.subject)
        return t('agentChat.request.title.mcp', {
            server: presentation.label,
            subject: presentation.subject,
        });
    const { kind, subject } = presentation;
    if (!subject || !isActionKind(kind))
        return t('agentChat.request.title.tool', { name: request.name });
    const action = t(`agentChat.request.action.${kind}`);
    return subject.length <= REQUEST_TITLE_SUBJECT_LENGTH && !subject.includes('\n')
        ? t('agentChat.request.title.actionSubject', { action, subject })
        : t('agentChat.request.title.action', { action });
}

/**
 * The approval or question card's heading. `providerName` is the provider catalog's display name, which a question
 * names as the one asking.
 */
export function agentChatLocalizedRequestTitle(
    request: AgentChatRequest,
    providerName: string,
    t: Translate = translate,
): string {
    switch (request.kind) {
        case 'command': {
            return request.networkHost
                ? t('agentChat.request.title.network', { host: request.networkHost })
                : t('agentChat.request.title.command');
        }
        case 'fileChange': {
            return t('agentChat.request.title.fileChange');
        }
        case 'tool': {
            return request.name === AGENT_CHAT_EXIT_PLAN_TOOL
                ? t('agentChat.request.title.plan')
                : toolRequestTitle(request, t);
        }
        case 'question': {
            return request.questions.length === 1
                ? t('agentChat.request.title.questionOne', { provider: providerName })
                : t('agentChat.request.title.questionOther', {
                      count: request.questions.length,
                      provider: providerName,
                  });
        }
    }
}

/**
 * What a turn blocked on the user is waiting for; the first pending request decides.
 */
export function agentChatLocalizedWaitingText(
    requests: readonly AgentChatRequest[],
    t: Translate = translate,
): string {
    const first = requests.at(0);
    return t(
        first && isAgentChatApprovalRequest(first)
            ? 'agentChat.waiting.approval'
            : 'agentChat.waiting.answer',
    );
}

const FAILURE_MESSAGE_KEYS: Record<AgentChatFailureReason, TranslationKey> = {
    conversation_in_use: 'agentChat.failure.conversationInUse',
    executable_not_found: 'agentChat.failure.executableNotFound',
    handshake_failed: 'agentChat.failure.handshakeFailed',
    process_exited: 'agentChat.failure.processExited',
    resume_failed: 'agentChat.failure.resumeFailed',
    spawn_failed: 'agentChat.failure.spawnFailed',
    unsupported_version: 'agentChat.failure.unsupportedVersion',
};

/**
 * The Desktop Chat's copy for a closed failure reason; provider text never selects the message.
 */
export function agentChatLocalizedFailureMessage(
    reason: AgentChatFailureReason,
    providerName: string,
    t: Translate = translate,
): string {
    return t(FAILURE_MESSAGE_KEYS[reason], { provider: providerName });
}
