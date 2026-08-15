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
    return !(
        focusedElement?.dataset.preserveTerminalFocus === 'true' &&
        focusedElement.closest<HTMLElement>('.work-tab')?.dataset.terminalId === terminalId
    );
}

/**
 * A PTY can become running after a modal or keyboard-operated work tab takes focus. Check those owners inside the
 * scheduled frame so the delayed transition cannot steal newer keyboard intent.
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
}: TerminalProcessFocusOptions): void {
    if (!active || !isRunning) {
        blur();
        return;
    }
    requestFrame(() => {
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
}
