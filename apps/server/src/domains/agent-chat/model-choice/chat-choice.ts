import type { AgentChatModelRequest, AgentProvider } from '@caxri/protocol';
import { agentChatDefaultsProviders, resolveAgentChatModelChange } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import { requireChatTerminal } from '../chat-launch';
import type { AgentChatProviderSession } from '../chat-provider';
import { chatStateStore } from '../chat-state-store';
import type { ChatState, ChatStates } from '../chat-states';
import type { AgentChatServiceOptions } from '../service-options';
import type { AgentChatDefaultChoice } from './stored-choice';
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

/**
 * The global default of an Agent whose config file Caxri reads; empty for one without such a default.
 */
async function resolveDefaults(
    options: ChatChoiceHost['options'],
    provider: AgentProvider,
): Promise<AgentChatDefaultChoice> {
    const defaultsProvider = agentChatDefaultsProviders.find((candidate) => candidate === provider);
    return defaultsProvider ? ((await options.defaults?.resolve(defaultsProvider)) ?? {}) : {};
}

/**
 * Agents that ignore their own config file's default when a Chat opens, so the Chat applies it itself: `agy acp` starts
 * every session on Antigravity's built-in model whatever `settings.json` names.
 */
const appliesDefaultAtStart = new Set<AgentProvider>(['antigravity']);

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
        const defaults = await resolveDefaults(options, provider);
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
 * worst case is a Chat on the global default, which the picker shows. An Agent that ignores its config file's default
 * gets that default applied first.
 */
export async function restoreChatChoice(
    { options, states }: ChatChoiceHost,
    terminalId: string,
    provider: AgentProvider,
    session: ChatChoiceSession,
    state: ChatState,
): Promise<void> {
    const { logger } = options;
    options.defaults?.observeModels(provider, state.projection.snapshot.models);
    // The Chat's own choice is layered over the default, as over a config file the provider read itself.
    if (appliesDefaultAtStart.has(provider))
        await applyStartDefault(options, terminalId, provider, session, state);
    const { snapshot } = state.projection;
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

/**
 * Puts a Chat with no choice of its own on its Agent's global default once it started, for an Agent that starts on its
 * built-in model whatever its config file names. Never fails the start: a Chat left on the built-in model is what the
 * picker shows.
 */
async function applyStartDefault(
    options: ChatChoiceHost['options'],
    terminalId: string,
    provider: AgentProvider,
    session: ChatChoiceSession,
    state: ChatState,
): Promise<void> {
    if (!session.configure) return;
    const { snapshot } = state.projection;
    let keys = '';
    let outcome = 'unchanged';
    try {
        const request = defaultChatChoiceRequest(
            snapshot,
            await resolveDefaults(options, provider),
        );
        keys = choiceKeys(request);
        if (hasChatChoice(request)) {
            await session.configure(resolveAgentChatModelChange(snapshot, request));
            outcome = 'applied';
        }
    } catch {
        outcome = 'failed';
    }
    options.logger.write(
        outcome === 'failed' ? 'warn' : 'info',
        logEventCatalog.agentChat.choiceApplied,
        { fields: { terminalId, provider, trigger: 'default', outcome, keys, dropped: '' } },
    );
}
