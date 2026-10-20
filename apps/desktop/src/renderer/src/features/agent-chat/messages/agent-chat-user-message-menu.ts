import { translate } from '../../../i18n';
import type { ContextMenuEntries, ContextMenuEntry } from '../../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../../lib/context-menu';

/**
 * One rewind action as a user message offers it: `undefined` when the message does not offer it at all, a reason string
 * while it is disabled, `null` while it can run. The same shape `AgentChatEditActions` reports.
 */
type ActionAvailability = string | null | undefined;

/**
 * What the copy part of a message's right-click menu needs, shared by the user's messages and the Agent's replies.
 */
export interface AgentChatMessageCopyMenuInput {
    /**
     * The whole message as it is copied: the user's words verbatim, or a reply's Markdown source.
     */
    text: string;
    /**
     * Text the user selected inside this message, if any; Copy and Add to Message then take the selection, and Copy
     * Message still copies the whole message.
     */
    selectedText: string;
    onCopy: (text: string) => void;
    /**
     * Quotes text into the Chat's message, as the selection toolbar's Add to message does. Absent where the timeline
     * has no Chat to write to (a task tab's read-only timeline), which leaves the entry out.
     */
    onQuote?: (text: string) => void;
}

/**
 * What a user message's right-click menu needs, read at the moment the menu opens.
 */
export interface AgentChatUserMessageMenuInput extends AgentChatMessageCopyMenuInput {
    edit: ActionAvailability;
    fork: ActionAvailability;
    restore: ActionAvailability;
    /**
     * True while a fork this message started is still opening, so the menu cannot start a second one.
     */
    isForking: boolean;
    /**
     * True while a Restore Code to Here this message started is still running, so the menu cannot start a second one.
     */
    isRestoring: boolean;
    onEdit: () => void;
    onFork: () => void;
    onRestore: () => void;
}

function rewindEntry(
    label: string,
    availability: ActionAvailability,
    onSelect: () => void,
    busyReason?: string,
): ContextMenuEntry | undefined {
    if (availability === undefined) return undefined;
    const reason = availability ?? busyReason;
    return reason === undefined
        ? { label, onSelect }
        : { label, onSelect, disabled: true, disabledReason: reason };
}

/**
 * Copy (the selection inside the message, offered only while there is one), Copy Message (the whole message, always
 * offered so a selection never hides it), then Add to Message, which quotes the selection or else the whole message
 * into the Chat's message.
 */
function agentChatMessageCopyEntries(
    input: AgentChatMessageCopyMenuInput,
): Array<ContextMenuEntry | undefined> {
    const selection = input.selectedText.trim() === '' ? '' : input.selectedText;
    const target = selection || input.text;
    const copySelection: ContextMenuEntry | undefined = selection
        ? { label: translate('common.copy'), onSelect: () => input.onCopy(selection) }
        : undefined;
    const copyMessage: ContextMenuEntry | undefined = input.text
        ? {
              label: translate('agentChat.userMenu.copyMessage'),
              onSelect: () => input.onCopy(input.text),
          }
        : undefined;
    const { onQuote } = input;
    const quote: ContextMenuEntry | undefined =
        onQuote && target.trim()
            ? {
                  label: translate('agentChat.userMenu.addToMessage'),
                  onSelect: () => onQuote(target),
              }
            : undefined;
    return [copySelection, copyMessage, quote];
}

/**
 * The right-click menu of an Agent reply: the same Copy, Copy Message, and Add to Message a user message leads with.
 * Copy Message takes the reply's Markdown source, as the hover row's Copy does.
 */
export function agentChatReplyMenu(input: AgentChatMessageCopyMenuInput): ContextMenuEntries {
    return agentChatMessageCopyEntries(input);
}

/**
 * The right-click menu of a user message: the same Copy, Edit from Here, Fork from Here, and Restore Code to Here its
 * hover row offers, so a mouse user who never hovers the row still finds them, plus Add to Message. A disabled action
 * stays listed with the reason the hover row's tooltip gives, and an action the message does not offer is left out.
 */
export function agentChatUserMessageMenu(input: AgentChatUserMessageMenuInput): ContextMenuEntries {
    return [
        ...agentChatMessageCopyEntries(input),
        CONTEXT_MENU_SEPARATOR,
        rewindEntry(translate('agentChat.userMenu.editFromHere'), input.edit, input.onEdit),
        rewindEntry(
            translate('agentChat.userMenu.forkFromHere'),
            input.fork,
            input.onFork,
            input.isForking ? translate('agentChat.userMenu.forkOpening') : undefined,
        ),
        rewindEntry(
            translate('agentChat.userMenu.restoreCodeToHere'),
            input.restore,
            input.onRestore,
            input.isRestoring ? translate('agentChat.undo.restoringCode') : undefined,
        ),
    ];
}
