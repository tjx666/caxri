const TERMINAL_CLEAR_EVENT = 'caxri:terminal-clear';

/** Drag payload type shared by the Terminal tab strip and the split-layout drop targets. */
export const TERMINAL_DRAG_TYPE = 'application/x-caxri-terminal';

interface TerminalClearDetail {
    terminalId: string;
}

export function clearTerminalView(terminalId: string): void {
    window.dispatchEvent(
        new CustomEvent<TerminalClearDetail>(TERMINAL_CLEAR_EVENT, {
            detail: { terminalId },
        }),
    );
}

export function onTerminalViewClear(terminalId: string, clear: () => void): () => void {
    const listener = (event: Event): void => {
        const detail = (event as CustomEvent<TerminalClearDetail>).detail;
        if (detail?.terminalId === terminalId) clear();
    };
    window.addEventListener(TERMINAL_CLEAR_EVENT, listener);
    return () => window.removeEventListener(TERMINAL_CLEAR_EVENT, listener);
}
