import type { TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { assertE2EAgentChatInput, readE2EAgentPolicy } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { isAgentChatCommandListed } from './chat-items';
import type { ChatState, ChatStateDelivery, ChatStates } from './chat-states';

/**
 * Whether a live Chat can be stopped without losing anything the user has not seen: its provider is ready and bound to
 * an Agent Session it can resume, and no turn, approval, operation, background task, or queued message is pending. A
 * Chat that is not bound yet has no conversation to resume, so stopping it would only discard its draft settings.
 */
export function isChatIdleForSuspension(
    state: ChatState,
    terminal: Pick<TerminalRecord, 'agentSessionId'>,
): boolean {
    const snapshot = state.projection.snapshot;
    return (
        state.session?.isOpen === true &&
        state.retiring === undefined &&
        terminal.agentSessionId !== undefined &&
        snapshot.status === 'ready' &&
        snapshot.activeTurnId === undefined &&
        snapshot.requests.length === 0 &&
        snapshot.operation === undefined &&
        !snapshot.tasks?.some((task) => task.status === 'running') &&
        (snapshot.queue?.length ?? 0) === 0 &&
        (snapshot.queueLength ?? 0) === 0
    );
}

/**
 * Stops an idle Chat's provider on its send chain once the Chat is still the same one and `isSuspendable` holds when
 * the stop reaches the head of the chain; see `AgentChatService.suspendIdle`. Returns the record, or `undefined` when
 * the Chat is not open or was no longer idle.
 */
export async function suspendIdleChat(
    database: Pick<CaxriDatabase, 'getTerminal'>,
    states: Pick<ChatStates, 'get'>,
    terminalId: string,
    isSuspendable: () => boolean,
): Promise<TerminalRecord | undefined> {
    const state = states.get(terminalId);
    if (!state) return undefined;
    const previous = state.sendQueue;
    const run = (async () => {
        await previous;
        if (states.get(terminalId) !== state || !isSuspendable()) return;
        // The requested exit records `suspended` through this flag whenever it lands; a provider (Claude) may report it
        // after `close` resolves, and writing here instead could overwrite a start that began since.
        state.suspending = true;
        const { session } = state;
        await session?.close();
        if (state.session === session) state.session = undefined;
        return database.getTerminal(terminalId);
    })();
    state.sendQueue = Promise.allSettled([run]);
    return run;
}

/**
 * Runs the provider's native compaction on an idle Chat through its send chain, only while the same launch (`launchId`)
 * is still idle when the command reaches the head of the chain; see `AgentChatService.compactIdle`. Rejects otherwise.
 */
export async function compactIdleChat(
    state: ChatState | undefined,
    launchId: string,
    chain: {
        enqueue: (state: ChatState, deliver: ChatStateDelivery) => Promise<void>;
        idleLaunchId: () => string | undefined;
    },
): Promise<void> {
    assertE2EAgentChatInput(readE2EAgentPolicy(), '/compact');
    if (!state || state.launchId !== launchId)
        throw new CaxriError('CONFLICT', 'This Chat changed before compaction');
    await chain.enqueue(state, async (session) => {
        if (state.launchId !== launchId || chain.idleLaunchId() !== launchId)
            throw new CaxriError('CONFLICT', 'This Chat changed before compaction');
        if (!isAgentChatCommandListed(state.projection.snapshot, 'compact'))
            throw new CaxriError('VALIDATION', '/compact is not available in this Chat');
        await session.runCommand('compact', undefined);
    });
}
