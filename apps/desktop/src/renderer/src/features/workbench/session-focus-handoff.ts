import { useEffect } from 'react';

import { isEditableEventTarget } from '../../lib/keybindings';
import { useDialogStore } from '../../stores/dialogs';
import { focusTerminalById } from '../terminal/terminal-pane-handlers';
import { getActivePaneTab } from './pane-actions';

/**
 * Whether selecting a Session may move keyboard focus into the Terminal it is showing.
 *
 * Before Session keep-alive (issue #657) nothing asked this question: switching Sessions rebuilt the whole Workbench,
 * and the Terminal's own attach completion claimed focus on the way up, gated by `shouldAutoFocusTerminal`. A retained
 * Session never attaches again, so the handoff has to be made explicitly, and with the same restraint, or the switch
 * would yank focus out of whatever the user is actually typing in.
 */
export function shouldHandOffSessionFocus(
    focusedElement: HTMLElement | null,
    isModalOpen: boolean,
): boolean {
    if (isModalOpen) return false;
    /**
     * Focus left behind inside the Session that just went off screen is focus nobody can see or use, so it is exactly
     * what this hands over, even though a Terminal's helper textarea reads as editable. Browsers usually blur it to
     * `document.body` when the wrapper turns `hidden`, but that is a side effect, not a guarantee worth depending on.
     */
    if (focusedElement?.closest('.workbench-session[hidden]')) return true;
    return !isEditableEventTarget(focusedElement);
}

/**
 * Hands keyboard focus to the newly selected Session's Terminal, restoring what the pre-keep-alive remount did.
 *
 * Only a Terminal: a document tab never claimed focus on a Session switch, and an Editor that kept its own cursor
 * through keep-alive is better left alone.
 */
export function useSessionFocusHandoff(selectedSessionId: string | undefined): void {
    useEffect(() => {
        if (!selectedSessionId) return;
        /**
         * Deferred a frame so the control that caused the switch settles first. A Command Palette restores focus to
         * whatever opened it as it closes, which lands _after_ this commit; running synchronously would focus the
         * Terminal and then immediately lose it again to that restore.
         */
        const frame = requestAnimationFrame(() => {
            const tab = getActivePaneTab();
            if (tab?.resource.kind !== 'terminal') return;
            if (
                !shouldHandOffSessionFocus(
                    document.activeElement as HTMLElement | null,
                    useDialogStore.getState().isModalOpen(),
                )
            )
                return;
            focusTerminalById(tab.resource.terminalId);
        });
        return () => cancelAnimationFrame(frame);
    }, [selectedSessionId]);
}
