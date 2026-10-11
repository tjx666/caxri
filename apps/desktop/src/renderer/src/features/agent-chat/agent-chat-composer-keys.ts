import { agentChatEscapeAction, agentChatSubmitDelivery } from './agent-chat-presentation';

/**
 * The fields of a composer `keydown` the Chat's shortcuts read; `isComposing` comes from the native event.
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
    { kind: 'cancelEdit' } | { kind: 'stop' } | { kind: 'submit'; delivery: 'steer' | undefined };

/**
 * What a key in the message input does once prompt history and the suggestion lists passed on it: Escape interrupts a
 * running turn, else cancels an "Edit from here" in progress, and Enter sends, queues, or (with Cmd/Ctrl during a turn)
 * steers. `undefined` leaves the key to the textarea.
 */
export function agentChatComposerKeyAction(
    key: AgentChatComposerKey,
    state: { isBusy: boolean; isEditing: boolean; isTurnRunning: boolean },
): AgentChatComposerKeyAction | undefined {
    const escape = agentChatEscapeAction(key, state);
    if (escape) return { kind: escape };
    const delivery = agentChatSubmitDelivery(key, state);
    if (!delivery) return undefined;
    return { kind: 'submit', delivery: delivery === 'steer' ? 'steer' : undefined };
}
