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

interface TerminalFocusOwnership {
    focusedElement: HTMLElement | null;
    isModalOpen: boolean;
    terminalId: string;
}

/**
 * Whether a Terminal's view (xterm, or the composer of a Terminal opened as Chat) may take keyboard focus without being
 * asked: not from behind a modal, not out of another editable control, not out of a region marked
 * `data-keeps-keyboard-focus` (the Commander Inbox, which the status bar's Needs you chip focuses while a Chat in the
 * same window is still mounting), and not away from a work tab that roving navigation deliberately left focused while
 * activating this very Terminal.
 */
export function canClaimTerminalFocus({
    focusedElement,
    isModalOpen,
    terminalId,
}: TerminalFocusOwnership): boolean {
    if (isModalOpen) return false;
    if (isEditableEventTarget(focusedElement)) return false;
    if (focusedElement?.closest('[data-keeps-keyboard-focus]')) return false;
    return !(
        focusedElement?.dataset.preserveTerminalFocus === 'true' &&
        focusedElement.closest<HTMLElement>('.work-tab')?.dataset.terminalId === terminalId
    );
}

/**
 * Work tab roving navigation deliberately leaves focus on the tab while activating its Terminal. Both the initial
 * attach completion and later process-state transitions use this gate so either asynchronous path respects that
 * keyboard ownership for the same Terminal.
 */
export function shouldAutoFocusTerminal({
    active,
    isRunning,
    ...ownership
}: TerminalFocusOwnership & { active: boolean; isRunning: boolean }): boolean {
    return active && isRunning && canClaimTerminalFocus(ownership);
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
