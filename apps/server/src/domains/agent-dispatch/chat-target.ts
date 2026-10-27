import { Buffer } from 'node:buffer';

import type {
    AgentEndpointRef,
    AgentLaunchSettings,
    TerminalRecord,
    TerminalSurface,
} from '@caxri/protocol';
import { CaxriError, isChatTerminal } from '@caxri/protocol';

import { assertPtyTerminal } from '../pty-guard';
import type { TerminalManager } from '../terminal';

/**
 * The part of `AgentChatService` the Agent-facing control paths drive when their target is a Chat Terminal.
 */
export interface DispatchChats {
    isLive(terminalId: string): boolean;
    /**
     * Starts a new Chat, or joins a start a Client's first read already began. A fresh delegated child uses it so its
     * prepared launch is not discarded by a restart racing that read.
     */
    start?(terminalId: string): Promise<void>;
    restart(terminalId: string): Promise<TerminalRecord>;
    /**
     * `origin` defaults to `human`, which takes a delegated Chat over; see `AgentChatService.send`.
     */
    send(
        terminalId: string,
        message: { text: string },
        delivery?: 'queue',
        origin?: 'human' | 'delegation',
    ): Promise<void>;
    interrupt(terminalId: string, by: 'agent'): Promise<void>;
    stopProvider(terminalId: string): Promise<void>;
    /**
     * Binds the next start of a delegated child Chat to its task; see `ChatDelegationLinks.prepareStart`.
     */
    delegation?: {
        prepareStart(
            terminalId: string,
            start: { launch: AgentLaunchSettings; delegationId?: string; agentSessionId?: string },
        ): void;
        /**
         * The launch whose provider process is live and not being retired; see `ChatDelegationLinks.liveLaunchId`.
         */
        liveLaunchId(terminalId: string): string | undefined;
    };
}

/**
 * A Chat target needs the Chat service; without one (a Server composed without Agent Chat) it is refused like any
 * PTY-only operation, before a receipt or input side effect exists.
 */
export function requireDispatchChats(
    terminal: { surface?: TerminalSurface },
    chats: DispatchChats | undefined,
): DispatchChats {
    if (chats) return chats;
    assertPtyTerminal(terminal);
    throw new CaxriError('UNAVAILABLE', 'Agent Chat is unavailable');
}

/**
 * Whether the dispatch target already runs an Agent, which `resume` and `wake` refuse. A Chat is live while its
 * provider runs or starts; its durable process state can be stale after a Server Core restart, when no Chat is live.
 */
export function isAgentLive(
    terminals: Pick<TerminalManager, 'agentProcessId'>,
    chats: DispatchChats | undefined,
    terminal: TerminalRecord,
): boolean {
    if (isChatTerminal(terminal)) return chats?.isLive(terminal.id) === true;
    return (
        terminal.lastAgentProcessState === 'running' ||
        terminals.agentProcessId(terminal.id) !== undefined
    );
}

/**
 * The Agent launch an exact resume must replace: a Chat's live provider launch, or a PTY Terminal's managed Agent
 * launch. Both comparison sites of `resume` read it, so a live Chat is compared with its own launch rather than with
 * the PTY launch it never has.
 */
export function currentAgentLaunchId(
    terminals: Pick<TerminalManager, 'agentLaunchId'>,
    chats: DispatchChats | undefined,
    terminal: TerminalRecord,
): string | undefined {
    if (isChatTerminal(terminal)) return chats?.delegation?.liveLaunchId(terminal.id);
    return terminals.agentLaunchId(terminal.id);
}

/**
 * `terminal.sendInternal` for a Chat: the text becomes one Chat message, queued behind a running turn like a message
 * typed in the Chat. Every Chat message submits, so `enter` has no separate effect. An attention reply is refused: a
 * Chat answers its attention requests through `agentChat.respond`, not through typed input.
 */
export async function sendToChat(
    chats: DispatchChats | undefined,
    terminal: TerminalRecord,
    input: { attentionGeneration?: number; enter: boolean; text: string },
) {
    if (input.attentionGeneration !== undefined)
        throw new CaxriError(
            'CONFLICT',
            'This Agent runs as a Chat; answer its request in the Chat instead of sending a reply',
        );
    await requireDispatchChats(terminal, chats).send(terminal.id, { text: input.text });
    return {
        terminalId: terminal.id,
        accepted: true as const,
        byteLength: Buffer.byteLength(input.text, 'utf8'),
        enter: input.enter,
    };
}

/**
 * `agent.control.interruptInternal`/`stopInternal` for a Chat whose current Endpoint generation was already proven:
 * SIGINT interrupts the running turn, and SIGHUP stops the provider while keeping the Terminal and its conversation.
 */
export async function signalChat(
    chats: DispatchChats | undefined,
    terminal: TerminalRecord,
    signal: 'SIGINT' | 'SIGHUP',
    endpoint: AgentEndpointRef,
    observeInterrupt: () => void,
) {
    const target = requireDispatchChats(terminal, chats);
    if (signal === 'SIGINT') {
        await target.interrupt(terminal.id, 'agent');
        observeInterrupt();
    } else await target.stopProvider(terminal.id);
    return { endpoint, terminalId: terminal.id, outcome: 'signaled' as const };
}
