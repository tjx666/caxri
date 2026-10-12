import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

import { useDialogStore } from '../../../stores/dialogs';
import { canClaimTerminalFocus } from '../../terminal/terminal-process-focus';

/**
 * Focuses the composer for an automatic focus claim (the Chat being shown) with the caret after the draft, so typing
 * continues a restored draft instead of prepending to it. React writes a restored draft as the textarea's initial
 * value, which leaves Chromium's selection at 0 until something moves it.
 *
 * Only that untouched 0..0 selection moves; any other selection is one the user placed and focus keeps it. This sets
 * the DOM selection only, never the caret `useAgentChatPlacedCaret` follows, so a restored draft ending in `@word`
 * still waits for the user before opening the Sessions list.
 */
export function focusComposerAtDraftEnd(input: HTMLTextAreaElement): void {
    input.focus();
    const { length } = input.value;
    if (length > 0 && input.selectionStart === 0 && input.selectionEnd === 0)
        input.setSelectionRange(length, length);
}

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
                    !canClaimTerminalFocus({
                        focusedElement: document.activeElement as HTMLElement | null,
                        isModalOpen: useDialogStore.getState().isModalOpen(),
                        terminalId,
                    })
                ) {
                    return;
                }

                const input = inputReference.current;
                if (input) focusComposerAtDraftEnd(input);
            });
        });
        return () => cancelAnimationFrame(frame);
    }, [inputReference, terminalId]);
}
