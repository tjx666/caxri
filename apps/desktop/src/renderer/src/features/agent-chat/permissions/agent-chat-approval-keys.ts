/**
 * Keyboard answers to an approval card. Plain Enter and Escape already mean send and interrupt in the composer (Escape
 * stops the running turn, which is exactly the turn waiting on the approval), so the approval keys are Command chords
 * from the keybinding registry instead: `agentChat.allowRequest` (`Cmd+Enter` by default) and `agentChat.denyRequest`
 * (`Cmd+Backspace`). This module decides which card, if any, a press may answer, so the chord never takes a key from a
 * surface that already does something with it.
 */

/**
 * The focused element as the key-owner rules read it.
 */
export interface AgentChatKeyTarget {
    isContentEditable?: boolean;
    role?: string | null;
    tagName?: string;
    value?: unknown;
}

const INTERACTIVE_ROLES = new Set([
    'button',
    'checkbox',
    'combobox',
    'gridcell',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'row',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem',
]);

/**
 * Whether focus rests somewhere that does nothing with a key: nothing focused, or a static element such as the
 * transcript. A text field, a contenteditable editor, a Terminal or Editor (both type into a hidden `textarea`), and a
 * button, link, tree row, or other control keep their own keys; a Session row archives on `Cmd+Backspace`, for one.
 */
export function isAgentChatStaticTarget(target: AgentChatKeyTarget | null): boolean {
    if (!target) return true;
    const tag = target.tagName?.toLowerCase() ?? '';
    if (['a', 'button', 'input', 'select', 'summary', 'textarea'].includes(tag)) return false;
    if (target.isContentEditable === true) return false;
    return !(target.role && INTERACTIVE_ROLES.has(target.role));
}

/**
 * Whether the element focus sits in leaves the composer empty for an approval key: a text field the user typed into
 * keeps its keys, while a button, the transcript, or an empty field does not. The composer is a contenteditable editor
 * that exposes its draft as `value` (`agent-chat-composer-editor.tsx`); another contenteditable without one reads as
 * holding text.
 */
export function isAgentChatComposerEmpty(target: AgentChatKeyTarget | null) {
    if (!target) return true;
    const tag = target.tagName?.toLowerCase();
    if (tag === 'textarea' || tag === 'input')
        return typeof target.value !== 'string' || target.value === '';
    if (target.isContentEditable !== true) return true;
    return typeof target.value === 'string' && target.value === '';
}

/**
 * Which approval an Allow or Deny key press answers, given where focus is.
 *
 * - Inside a Chat pane that shows an approval (the waiting popup's card counts as one), that pane's first approval, as
 *   long as the composer holds no draft: a draft keeps `Cmd+Enter` for queueing it.
 * - Anywhere else, the waiting popup's approval, but only from a static spot (`isAgentChatStaticTarget`). The popup never
 *   takes focus, so this is what lets a user answer it without the mouse; a surface that owns the chord, even an empty
 *   composer or a Session row, keeps it.
 */
export function agentChatApprovalKeyOwner(
    target: AgentChatKeyTarget | null,
    pane: 'none' | 'withApproval' | 'withoutApproval',
): 'pane' | 'popup' | undefined {
    if (pane === 'withApproval') return isAgentChatComposerEmpty(target) ? 'pane' : undefined;
    return isAgentChatStaticTarget(target) ? 'popup' : undefined;
}
