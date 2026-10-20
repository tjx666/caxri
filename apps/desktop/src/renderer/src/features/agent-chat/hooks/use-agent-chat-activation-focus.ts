import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';

import { useDialogStore } from '../../../stores/dialogs';
import { registerTerminalFocusHandler } from '../../terminal/terminal-pane-handlers';
import { canClaimTerminalFocus } from '../../terminal/terminal-process-focus';
import { agentChatDraftEndCaret } from '../composer/agent-chat-composer-caret';
import type { AgentChatComposerInput } from '../composer/agent-chat-composer-view';

/**
 * Focuses the composer for an automatic focus claim (the Chat being shown) with the caret after the draft, so typing
 * continues a restored draft instead of prepending to it. The editor takes a restored draft with its caret at 0, where
 * it stays until something moves it.
 *
 * Only that untouched 0..0 selection moves; a selection the user placed, including a caret deliberately put at the
 * start of the draft, is kept (see `agentChatDraftEndCaret`). This sets the DOM selection only, never the caret
 * `useAgentChatPlacedCaret` follows, so a restored draft ending in `@word` still waits for the user before opening the
 * Sessions list.
 */
function focusComposerAtDraftEnd(input: AgentChatComposerInput): void {
    input.focus();
    const caret = agentChatDraftEndCaret(input);
    if (caret !== undefined) input.setSelectionRange(caret, caret);
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
 *
 * It also registers the Chat's focus handler, through which a later explicit focus request (showing its Session again,
 * a focus command) lands in the composer with the same draft-end caret.
 */
export function useAgentChatActivationFocus(
    inputReference: RefObject<AgentChatComposerInput | null>,
    { isShown, terminalId }: { isShown: boolean; terminalId: string },
): void {
    const isShownOnMount = useRef(isShown);
    useEffect(
        () =>
            registerTerminalFocusHandler(
                terminalId,
                () => {
                    const input = inputReference.current;
                    if (input) focusComposerAtDraftEnd(input);
                },
                () => inputReference.current?.element ?? null,
            ),
        [inputReference, terminalId],
    );
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
