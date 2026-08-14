interface TerminalProcessFocusOptions {
    active: boolean;
    blur: () => void;
    focus: () => void;
    isModalOpen: () => boolean;
    isRunning: boolean;
    requestFrame: (callback: FrameRequestCallback) => number;
}

/**
 * A PTY can become running after a modal has opened. Check modal ownership inside the scheduled
 * frame so the delayed Terminal transition cannot steal keyboard input from that newer UI state.
 */
export function reconcileTerminalProcessFocus({
    active,
    blur,
    focus,
    isModalOpen,
    isRunning,
    requestFrame,
}: TerminalProcessFocusOptions): void {
    if (!active || !isRunning) {
        blur();
        return;
    }
    requestFrame(() => {
        if (!isModalOpen()) focus();
    });
}
