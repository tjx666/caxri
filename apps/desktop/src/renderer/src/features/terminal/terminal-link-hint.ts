import type { Terminal } from '@xterm/xterm';

/**
 * The default hover label spells out the platform key so a user knows why a bare click keeps selecting text.
 */
const TERMINAL_LINK_HINT_TEXT = '⌘ click to open';

/**
 * Pure placement math kept separate from DOM writes so it can be unit tested without a browser environment.
 */
export function terminalLinkHintPosition(event: { clientX: number; clientY: number }): {
    left: number;
    top: number;
} {
    return { left: event.clientX + 12, top: event.clientY - 28 };
}

export interface TerminalLinkHintController {
    dispose(): void;
    hide(): void;
    show(event: MouseEvent, text?: string): void;
}

/**
 * Creates the single hover-hint element lazily inside `terminal.element`, following xterm's `ILinkHandler.hover`
 * guidance. The `xterm-hover` class prevents events from falling through to neighboring links.
 */
export function createTerminalLinkHintController(terminal: Terminal): TerminalLinkHintController {
    let element: HTMLDivElement | undefined;
    return {
        show(event, text = TERMINAL_LINK_HINT_TEXT) {
            const host = terminal.element;
            if (!host) return;
            if (!element) {
                element = document.createElement('div');
                element.className =
                    'xterm-hover terminal-link-hint pointer-events-none fixed z-[90] rounded-md bg-elevated px-2.5 py-1.5 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]';
                element.setAttribute('role', 'tooltip');
                host.append(element);
            }
            element.textContent = text;
            const { left, top } = terminalLinkHintPosition(event);
            element.style.left = `${left}px`;
            element.style.top = `${top}px`;
        },
        hide() {
            element?.remove();
            element = undefined;
        },
        dispose() {
            element?.remove();
            element = undefined;
        },
    };
}
