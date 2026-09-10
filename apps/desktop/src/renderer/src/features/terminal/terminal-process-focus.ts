import { isEditableEventTarget } from '../../lib/keybindings';

interface TerminalProcessFocusOptions {
    active: boolean;
    blur: () => void;
    focus: () => void;
    getFocusedElement: () => HTMLElement | null;
    isModalOpen: () => boolean;
    isRunning: boolean;
    requestFrame: (callback: FrameRequestCallback) => number;
    terminalId: string;
}

/**
 * Work tab roving navigation deliberately leaves focus on the tab while activating its Terminal. Both the initial
 * attach completion and later process-state transitions use this gate so either asynchronous path respects that
 * keyboard ownership for the same Terminal.
 */
export function shouldAutoFocusTerminal({
    active,
    focusedElement,
    isModalOpen,
    isRunning,
    terminalId,
}: {
    active: boolean;
    focusedElement: HTMLElement | null;
    isModalOpen: boolean;
    isRunning: boolean;
    terminalId: string;
}): boolean {
    if (!active || !isRunning || isModalOpen) return false;
    if (isEditableEventTarget(focusedElement)) return false;
    return !(
        focusedElement?.dataset.preserveTerminalFocus === 'true' &&
        focusedElement.closest<HTMLElement>('.work-tab')?.dataset.terminalId === terminalId
    );
}

/**
 * A PTY can become running after a modal, editable control, or keyboard-operated work tab takes focus. Check those
 * owners inside the scheduled frame so the delayed transition cannot steal newer keyboard intent. The owning effect
 * must invalidate this frame on cleanup: its captured running/active state may be obsolete before the frame runs.
 */
export function reconcileTerminalProcessFocus({
    active,
    blur,
    focus,
    getFocusedElement,
    isModalOpen,
    isRunning,
    requestFrame,
    terminalId,
}: TerminalProcessFocusOptions): (() => void) | undefined {
    if (!active || !isRunning) {
        blur();
        return;
    }
    let isInvalidated = false;
    requestFrame(() => {
        if (isInvalidated) return;
        if (
            shouldAutoFocusTerminal({
                active,
                focusedElement: getFocusedElement(),
                isModalOpen: isModalOpen(),
                isRunning,
                terminalId,
            })
        )
            focus();
    });
    return () => {
        isInvalidated = true;
    };
}
