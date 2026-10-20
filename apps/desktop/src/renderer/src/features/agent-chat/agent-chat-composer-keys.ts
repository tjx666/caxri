import { agentChatEscapeAction, agentChatSubmitDelivery } from './agent-chat-presentation';

/**
 * The fields of a composer `keydown` the Chat's shortcuts read; `isComposing` comes from `isImeComposing`.
 */
export interface AgentChatComposerKey {
    altKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    key: string;
    metaKey: boolean;
    repeat: boolean;
    shiftKey: boolean;
}

export type AgentChatComposerKeyAction =
    | { kind: 'cancelEdit' }
    | { kind: 'sendQueued'; id: string }
    | { kind: 'stop' }
    | { kind: 'submit'; delivery: 'steer' | undefined };

/**
 * What a key in the message input does once prompt history and the suggestion lists passed on it: Escape interrupts a
 * running turn, else cancels an "Edit from here" in progress, and Enter sends, queues, or (with Cmd/Ctrl during a turn)
 * steers. Enter (with or without Cmd/Ctrl) in an empty composer sends the head of the queue now instead, as its Steer
 * or Send now button would, since an empty message has nothing else to send. `undefined` leaves the key to the editor.
 */
export function agentChatComposerKeyAction(
    key: AgentChatComposerKey,
    state: {
        isBusy: boolean;
        isEditing: boolean;
        isTurnRunning: boolean;
        /**
         * The queued message an empty composer's Enter sends now (`agentChatNextQueuedId`); left out while the composer
         * holds text or images, edits an earlier message, or is still sending one (the input clears before the message
         * reaches the queue, so a quick second Enter would otherwise send an older entry).
         */
        nextQueuedId?: string;
    },
): AgentChatComposerKeyAction | undefined {
    const escape = agentChatEscapeAction(key, state);
    if (escape) return { kind: escape };
    const delivery = agentChatSubmitDelivery(key, state);
    if (!delivery) return undefined;
    // A held Enter repeats right after the message it sent cleared the input; that repeat must not send the queue too.
    if (state.nextQueuedId !== undefined && !key.repeat)
        return { kind: 'sendQueued', id: state.nextQueuedId };
    return { kind: 'submit', delivery: delivery === 'steer' ? 'steer' : undefined };
}

/**
 * Whether a composer key is Cmd+Shift+V (Ctrl+Shift+V off macOS), "paste as plain text": the clipboard's text goes in
 * as typed rather than through the long-paste file. Shift changes `key` to `V` on most layouts, so case is ignored.
 */
export function isAgentChatPlainPasteKey(
    key: Pick<AgentChatComposerKey, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
): boolean {
    return (
        (key.metaKey || key.ctrlKey) && key.shiftKey && !key.altKey && key.key.toLowerCase() === 'v'
    );
}
