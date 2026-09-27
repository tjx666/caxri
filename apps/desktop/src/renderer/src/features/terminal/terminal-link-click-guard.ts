import type { Terminal } from '@xterm/xterm';

import type { TerminalLinkHintController } from './terminal-link-hint';

/**
 * Matches VS Code/iTerm2: a link only activates while the platform's "open" modifier is held, instead of on a bare
 * click. Caxri ships only on macOS, where Ctrl+click is reserved for the secondary-click gesture.
 */
export function hasLinkActivationModifier(event: MouseEvent): boolean {
    return event.metaKey;
}

/**
 * Keeps a Cmd+click on a link from also reaching a foreground app that enabled mouse tracking. xterm's mouse report
 * drops `metaKey`, so an app such as Codex's fullscreen transcript sees a plain left click on the same link and opens
 * it a second time. Like iTerm2 and Ghostty, Caxri owns that click: xterm's Linkifier listens on `.xterm-screen` and
 * still activates the link, while stopping the bubble there keeps the event from xterm's mouse service on the enclosing
 * `.xterm` element, which never sends the press or arms its release listener. Every other click is still forwarded.
 */
export function registerMouseTrackingLinkClickGuard(
    terminal: Terminal,
    hint: TerminalLinkHintController,
): () => void {
    const screen = terminal.screenElement;
    if (!screen) return () => {};
    const onMouseDown = (event: MouseEvent) => {
        if (
            event.button !== 0 ||
            !hasLinkActivationModifier(event) ||
            terminal.modes.mouseTrackingMode === 'none' ||
            !hint.isLinkHovered()
        )
            return;
        event.stopPropagation();
        // The skipped mouse service would have suppressed native selection and focused the Terminal.
        event.preventDefault();
        terminal.focus();
    };
    screen.addEventListener('mousedown', onMouseDown);
    return () => screen.removeEventListener('mousedown', onMouseDown);
}
