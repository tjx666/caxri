import { isChatTerminal } from '@caxri/protocol';

import type { DelegationChatTurn } from '../agent-delegation';
import type { DispatchChats } from '../agent-dispatch';
import type { CaxriDatabase } from '../db';

/**
 * The part of `AgentChatService` Agent delegation drives when a task's Terminal is a Chat.
 */
export interface DelegationChats extends DispatchChats {
    delegation: NonNullable<DispatchChats['delegation']> & {
        sendToLaunch(terminalId: string, launchId: string, text: string): Promise<void>;
        inputEpoch(terminalId: string): number;
        turnAnswer(terminalId: string, turnId: string): DelegationChatTurn;
    };
}

/**
 * The Chat service when `terminalId` is a Chat Terminal, else `undefined` (a PTY Terminal, or no Chat service).
 */
export function delegationChatFor(
    database: Pick<CaxriDatabase, 'getTerminal'>,
    chats: DelegationChats | undefined,
    terminalId: string,
): DelegationChats | undefined {
    const terminal = chats && database.getTerminal(terminalId);
    return terminal && isChatTerminal(terminal) ? chats : undefined;
}

const PASTE_START = '\u{1B}[200~';
const PASTE_END = '\u{1B}[201~\r';
const ESCAPE = '\u{1B}';

/**
 * The text of one bracketed paste followed by Enter, or `undefined` for any other input.
 */
function pastedText(data: string): string | undefined {
    if (!data.startsWith(PASTE_START) || !data.endsWith(PASTE_END)) return undefined;
    const text = data.slice(PASTE_START.length, -PASTE_END.length);
    return text.includes(PASTE_START) || text.includes(PASTE_END) ? undefined : text;
}

/**
 * Delivers a delegation write to a Chat, the counterpart of `TerminalManager.writeAgentExact`. The delegation service
 * writes PTY input: a follow-up's task pointer as one bracketed paste followed by Enter, and a stop as a bare Esc. A
 * Chat takes the pointer as one message (its exact text, so the turn's prompt digest matches) and the Esc as an
 * interrupt; anything else is refused. Admission is synchronous against the exact live launch, and the message is
 * checked against it again when it reaches the head of the Chat's send chain, so it never starts a provider for a later
 * launch. The interrupt is issued in the admitting turn. `onDelivered` reports whether the Chat accepted it.
 */
export function didAcceptDelegationChatWrite(
    chats: DelegationChats,
    terminalId: string,
    launchId: string,
    data: string,
    onDelivered?: (wasAccepted: boolean) => void,
): boolean {
    if (chats.delegation.liveLaunchId(terminalId) !== launchId) return false;
    const text = pastedText(data);
    if (data !== ESCAPE && text === undefined) return false;
    const deliver = async () => {
        try {
            await (text === undefined
                ? chats.interrupt(terminalId, 'agent')
                : chats.delegation.sendToLaunch(terminalId, launchId, text));
            onDelivered?.(true);
        } catch {
            onDelivered?.(false);
        }
    };
    void deliver();
    return true;
}
