import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

import { useDialogStore } from '../../../stores/dialogs';
import { canClaimTerminalFocus } from '../../terminal/terminal-process-focus';

/**
 * Showing a Chat (activating its tab, switching it from the Terminal surface, or opening a new one) hands keyboard
 * focus to the composer, the way activating a Terminal tab hands it to xterm, so the user can type straight away. It
 * obeys the same restraint as the Terminal (`canClaimTerminalFocus`).
 *
 * It runs once per mount. A pane renders only its active tab, so a mount is exactly an activation; reacting to the pane
 * becoming active later would pull focus out of the timeline whenever a click or Tab moved into it from another pane. A
 * Chat that mounts in a hidden Session or an inactive pane claims nothing; showing that Session later is
 * `useSessionFocusHandoff`'s job, through the focus handler the Chat registers.
 *
 * The claim waits two frames. Tab focus recovery repairs a lost focus one frame after a layout edit, and when the user
 * was navigating the tab bar it parks focus on the tab with the marker this check honors; claiming first would overrule
 * that keyboard navigation.
 */
export function useAgentChatActivationFocus(
    inputReference: RefObject<HTMLTextAreaElement | null>,
    { isShown, terminalId }: { isShown: boolean; terminalId: string },
): void {
    const isShownOnMount = useRef(isShown);
    useEffect(() => {
        if (!isShownOnMount.current) return;
        let frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
                if (
                    canClaimTerminalFocus({
                        focusedElement: document.activeElement as HTMLElement | null,
                        isModalOpen: useDialogStore.getState().isModalOpen(),
                        terminalId,
                    })
                )
                    inputReference.current?.focus();
            });
        });
        return () => cancelAnimationFrame(frame);
    }, [inputReference, terminalId]);
}
