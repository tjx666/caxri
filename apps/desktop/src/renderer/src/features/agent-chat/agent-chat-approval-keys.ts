/**
 * Keyboard answers to the approval card above the composer. Plain Enter and Escape already mean send and interrupt in
 * the composer (Escape stops the running turn, which is exactly the turn waiting on the approval), so the approval keys
 * take the Command chord instead: Cmd+Enter accepts and Cmd+Backspace denies. Both are no-ops in an empty composer
 * otherwise (there is nothing to steer and nothing to delete), so they only answer while the composer is empty.
 */
export const AGENT_CHAT_APPROVE_SHORTCUT = 'cmd+enter';
export const AGENT_CHAT_DENY_SHORTCUT = 'cmd+backspace';

/**
 * The approval decision a key press inside the Chat pane makes, or `undefined` when it is not an approval key. A held
 * key never answers twice, an IME composition owns its keys, and an extra modifier leaves the chord to whoever owns
 * it.
 */
export function agentChatApprovalKeyDecision(
    event: {
        key: string;
        metaKey: boolean;
        ctrlKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
        isComposing: boolean;
        repeat: boolean;
    },
    state: { isComposerEmpty: boolean },
): 'accept' | 'decline' | undefined {
    if (!state.isComposerEmpty || event.isComposing || event.repeat) return undefined;
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return undefined;
    if (event.key === 'Enter') return 'accept';
    if (event.key === 'Backspace') return 'decline';
    return undefined;
}

/**
 * Whether the element focus sits in leaves the composer empty for an approval key: a text field the user typed into
 * keeps its keys, while a button, the transcript, or an empty field does not.
 */
export function isAgentChatComposerEmpty(target: { value?: unknown; tagName?: string } | null) {
    if (!target) return true;
    const tag = target.tagName?.toLowerCase();
    if (tag !== 'textarea' && tag !== 'input') return true;
    return typeof target.value !== 'string' || target.value === '';
}
