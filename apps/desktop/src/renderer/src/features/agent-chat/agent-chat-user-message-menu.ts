import { translate } from '../../i18n';
import type { ContextMenuEntries, ContextMenuEntry } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';

/**
 * One rewind action as a user message offers it: `undefined` when the message does not offer it at all, a reason string
 * while it is disabled, `null` while it can run. The same shape `AgentChatEditActions` reports.
 */
type ActionAvailability = string | null | undefined;

/**
 * What a user message's right-click menu needs, read at the moment the menu opens.
 */
export interface AgentChatUserMessageMenuInput {
    text: string;
    /**
     * Text the user selected inside this message, if any; Copy then takes the selection instead of the whole message.
     */
    selectedText: string;
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
    onCopy: (text: string) => void;
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
 * The right-click menu of a user message: the same Copy, Edit from Here, Fork from Here, and Restore Code to Here its
 * hover row offers, so a mouse user who never hovers the row still finds them. A disabled action stays listed with the
 * reason the hover row's tooltip gives, and an action the message does not offer is left out.
 */
export function agentChatUserMessageMenu(input: AgentChatUserMessageMenuInput): ContextMenuEntries {
    const selection = input.selectedText.trim() === '' ? '' : input.selectedText;
    const copy: ContextMenuEntry | undefined = selection
        ? { label: translate('common.copy'), onSelect: () => input.onCopy(selection) }
        : input.text
          ? {
                label: translate('agentChat.userMenu.copyMessage'),
                onSelect: () => input.onCopy(input.text),
            }
          : undefined;
    return [
        copy,
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
