import type { AgentChatModelRequest, AgentProvider } from '@caxri/protocol';
import { resolveAgentChatModelChange } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import { requireChatTerminal } from '../chat-launch';
import type { AgentChatProviderSession } from '../chat-provider';
import { chatStateStore } from '../chat-state-store';
import type { ChatState, ChatStates } from '../chat-states';
import type { AgentChatServiceOptions } from '../service-options';
import {
    defaultChatChoiceRequest,
    hasChatChoice,
    nextChatChoice,
    restorableChatChoice,
} from './stored-choice';

/**
 * What applying a Chat's model choice needs from the service that owns the Chat.
 */
export interface ChatChoiceHost {
    options: Pick<AgentChatServiceOptions, 'database' | 'defaults' | 'logger'>;
    states: Pick<ChatStates, 'apply'>;
}

type ChatChoiceSession = Pick<AgentChatProviderSession, 'configure'>;

const choiceKeys = (request: AgentChatModelRequest): string =>
    Object.keys(request)
        .toSorted((left, right) => left.localeCompare(right))
        .join(',');

/**
 * Applies a model picker switch to the running provider and remembers it as the Chat's own choice, so the Chat comes
 * back on it after a restart, an idle suspension, or a crash. Only the Chat changes: the Agent's global default lives
 * in its config file and is edited from Settings.
 */
export async function switchChatChoice(
    { options, states }: ChatChoiceHost,
    terminalId: string,
    session: ChatChoiceSession,
    state: ChatState,
    request: AgentChatModelRequest,
): Promise<void> {
    const config = resolveAgentChatModelChange(state.projection.snapshot, request);
    if (Object.keys(config).length === 0 || !session.configure) return;
    await session.configure(config);
    const store = chatStateStore(options.database);
    store.setChoice(terminalId, nextChatChoice(store.choice(terminalId), request, config));
    states.apply(terminalId, [{ op: 'state', state: { customChoice: true } }]);
}

/**
 * Puts the Chat back on its Agent's global default (the picker's ↺) and forgets its own choice. The choice is cleared
 * only once the provider took the default, so a failed reset leaves the Chat as it was.
 */
export async function resetChatChoice(
    { options, states }: ChatChoiceHost,
    terminalId: string,
    session: ChatChoiceSession,
    state: ChatState,
): Promise<void> {
    const { logger } = options;
    const { provider } = requireChatTerminal(options.database, terminalId);
    let keys = '';
    try {
        const defaults =
            provider === 'claude' || provider === 'codex'
                ? ((await options.defaults?.resolve(provider)) ?? {})
                : {};
        const request = defaultChatChoiceRequest(state.projection.snapshot, defaults);
        keys = choiceKeys(request);
        if (hasChatChoice(request) && session.configure)
            await session.configure(
                resolveAgentChatModelChange(state.projection.snapshot, request),
            );
    } catch (error) {
        logger.write('warn', logEventCatalog.agentChat.choiceApplied, {
            fields: {
                terminalId,
                provider,
                trigger: 'reset',
                outcome: 'failed',
                keys,
                dropped: '',
            },
        });
        throw error;
    }
    chatStateStore(options.database).setChoice(terminalId, {});
    states.apply(terminalId, [{ op: 'state', state: { customChoice: null } }]);
    logger.write('info', logEventCatalog.agentChat.choiceApplied, {
        fields: {
            terminalId,
            provider,
            trigger: 'reset',
            outcome: keys ? 'applied' : 'unchanged',
            keys,
            dropped: '',
        },
    });
}

/**
 * Re-applies a Chat's own choice once its provider started, before the Chat reports ready, so the first turn after a
 * restart already runs on it. Each key is checked against what the provider offers now; a key it no longer accepts is
 * skipped but kept, so a model that is only briefly unlisted comes back on a later start. Never fails the start: the
 * worst case is a Chat on the global default, which the picker shows.
 */
export async function restoreChatChoice(
    { options, states }: ChatChoiceHost,
    terminalId: string,
    provider: AgentProvider,
    session: ChatChoiceSession,
    state: ChatState,
): Promise<void> {
    const { logger } = options;
    const { snapshot } = state.projection;
    options.defaults?.observeModels(provider, snapshot.models);
    const stored = chatStateStore(options.database).choice(terminalId);
    if (!hasChatChoice(stored)) return;
    states.apply(terminalId, [{ op: 'state', state: { customChoice: true } }]);
    if (!session.configure) return;
    const log = (outcome: string, keys: string, dropped: string) =>
        logger.write(
            outcome === 'failed' ? 'warn' : 'info',
            logEventCatalog.agentChat.choiceApplied,
            {
                fields: { terminalId, provider, trigger: 'start', outcome, keys, dropped },
            },
        );
    const restorable = restorableChatChoice(snapshot, stored);
    if (!restorable) {
        log('deferred', '', '');
        return;
    }
    const keys = choiceKeys(restorable.request);
    const dropped = restorable.dropped
        .toSorted((left, right) => left.localeCompare(right))
        .join(',');
    if (!hasChatChoice(restorable.request)) {
        log('unchanged', '', dropped);
        return;
    }
    try {
        await session.configure(resolveAgentChatModelChange(snapshot, restorable.request));
        log('applied', keys, dropped);
    } catch {
        log('failed', keys, dropped);
    }
}
