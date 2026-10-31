import { notifyListeners } from '@caxri/utils';

import type { AgentChatAttachment } from '../agent-chat-drafts';

/**
 * Surfaces that render from a Chat's draft (the turn review's pending comment count) and so need to hear every write,
 * whether it came from typing, from another surface, or from the stored state arriving.
 */
const draftChangeListeners = new Map<string, Set<() => void>>();

export function notifyDraftChange(terminalId: string): void {
    const listeners = draftChangeListeners.get(terminalId);
    if (!listeners) return;
    // One throwing surface cannot stop the others from hearing the write; Desktop mirrors `console.error` into its log.
    notifyListeners(listeners, undefined, (error) =>
        console.error('agentChat.draft listener failed', error),
    );
}

/**
 * Calls `listener` after each change to a Chat's stored draft. Returns the unsubscribe. Pairs with `readAgentChatDraft`
 * as a `useSyncExternalStore` source.
 */
export function subscribeAgentChatDraftChanges(
    terminalId: string,
    listener: () => void,
): () => void {
    let listeners = draftChangeListeners.get(terminalId);
    if (!listeners) {
        listeners = new Set();
        draftChangeListeners.set(terminalId, listeners);
    }
    listeners.add(listener);
    return () => {
        const current = draftChangeListeners.get(terminalId);
        current?.delete(listener);
        if (current?.size === 0) draftChangeListeners.delete(terminalId);
    };
}

type UnsentReturnListener = (text: string, attachments: readonly AgentChatAttachment[]) => void;

/**
 * The mounted composer of each Chat, which takes a message whose send failed back into its live draft and attachments.
 * The send cleared the composer at once, so by the time it fails the composer that sent it may have unmounted, or been
 * replaced by one that read the stored draft when it mounted; only the one on screen can merge the message with what
 * the user typed since.
 */
const returnListeners = new Map<string, UnsentReturnListener>();

/**
 * Registers the mounted composer of `terminalId` to receive `returnUnsentAgentChatMessage`. Returns the unsubscribe.
 */
export function subscribeAgentChatUnsentReturns(
    terminalId: string,
    listener: UnsentReturnListener,
): () => void {
    returnListeners.set(terminalId, listener);
    return () => {
        if (returnListeners.get(terminalId) === listener) returnListeners.delete(terminalId);
    };
}

/**
 * Hands a returned message to the composer of `terminalId` when one is mounted. Returns whether it took it.
 */
export function didDeliverToMountedComposer(
    terminalId: string,
    text: string,
    attachments: readonly AgentChatAttachment[],
): boolean {
    const listener = returnListeners.get(terminalId);
    if (!listener) return false;
    listener(text, attachments);
    return true;
}
