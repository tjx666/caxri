interface TerminalProcessFocusOptions {
    active: boolean;
    blur: () => void;
    focus: () => void;
    isModalOpen: () => boolean;
    isRunning: boolean;
    requestFrame: (callback: FrameRequestCallback) => number;
    shouldPreserveFocus: () => boolean;
}

/**
 * A PTY can become running after a modal or keyboard-operated work tab takes focus. Check those
 * owners inside the scheduled frame so the delayed transition cannot steal newer keyboard intent.
 */
export function reconcileTerminalProcessFocus({
    active,
    blur,
    focus,
    isModalOpen,
    isRunning,
    requestFrame,
    shouldPreserveFocus,
}: TerminalProcessFocusOptions): void {
    if (!active || !isRunning) {
        blur();
        return;
    }
    requestFrame(() => {
        if (!isModalOpen() && !shouldPreserveFocus()) focus();
    });
}
