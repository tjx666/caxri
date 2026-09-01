import type { Terminal } from '@xterm/xterm';

export const TERMINAL_LINK_HINT_DELAY_MS = 500;
const TERMINAL_LINK_HINT_GAP = 12;
const TERMINAL_LINK_HINT_VIEWPORT_PADDING = 8;

interface TerminalLinkHintSize {
    height: number;
    width: number;
}

interface TerminalLinkHintViewport {
    height: number;
    width: number;
}

interface TerminalLinkHintAnchor {
    bottom: number;
    clientX: number;
    top: number;
}

/**
 * Keeps the pointer and current Terminal row clear, then flips and clamps the popup at viewport edges.
 */
export function terminalLinkHintPosition(
    anchor: TerminalLinkHintAnchor,
    hint: TerminalLinkHintSize,
    viewport: TerminalLinkHintViewport,
): {
    left: number;
    top: number;
} {
    const maxLeft = Math.max(
        TERMINAL_LINK_HINT_VIEWPORT_PADDING,
        viewport.width - hint.width - TERMINAL_LINK_HINT_VIEWPORT_PADDING,
    );
    const maxTop = Math.max(
        TERMINAL_LINK_HINT_VIEWPORT_PADDING,
        viewport.height - hint.height - TERMINAL_LINK_HINT_VIEWPORT_PADDING,
    );
    const preferredLeft = anchor.clientX + TERMINAL_LINK_HINT_GAP;
    const preferredTop = anchor.top - hint.height - TERMINAL_LINK_HINT_GAP;
    const flippedLeft = anchor.clientX - hint.width - TERMINAL_LINK_HINT_GAP;
    const flippedTop = anchor.bottom + TERMINAL_LINK_HINT_GAP;
    const left =
        preferredLeft + hint.width <= viewport.width - TERMINAL_LINK_HINT_VIEWPORT_PADDING
            ? preferredLeft
            : flippedLeft;
    const top = preferredTop >= TERMINAL_LINK_HINT_VIEWPORT_PADDING ? preferredTop : flippedTop;
    return {
        left: Math.min(maxLeft, Math.max(TERMINAL_LINK_HINT_VIEWPORT_PADDING, left)),
        top: Math.min(maxTop, Math.max(TERMINAL_LINK_HINT_VIEWPORT_PADDING, top)),
    };
}

function terminalLinkHintAnchor(terminal: Terminal, event: MouseEvent): TerminalLinkHintAnchor {
    const screenBounds = terminal.screenElement?.getBoundingClientRect();
    if (
        screenBounds &&
        terminal.rows > 0 &&
        event.clientY >= screenBounds.top &&
        event.clientY <= screenBounds.bottom
    ) {
        const rowHeight = screenBounds.height / terminal.rows;
        const rowIndex = Math.min(
            terminal.rows - 1,
            Math.floor((event.clientY - screenBounds.top) / rowHeight),
        );
        const top = screenBounds.top + rowIndex * rowHeight;
        return { bottom: top + rowHeight, clientX: event.clientX, top };
    }
    return { bottom: event.clientY, clientX: event.clientX, top: event.clientY };
}

export interface TerminalLinkHintController {
    dispose(): void;
    hide(): void;
    leave(): void;
    show(
        event: MouseEvent,
        text: string,
        onModifierChange?: (isModifierDown: boolean) => void,
        linkKey?: string,
    ): void;
}

/**
 * Owns one delayed hover popup and one modifier-listener set per Terminal. xterm replaces a link's decoration object
 * immediately after `hover` returns, so the initial modifier state is applied in a microtask, after those public
 * setters exist. A render can also synchronously leave and reprovide the same link; delaying that leave until the
 * microtask boundary keeps the already-visible popup mounted without delaying a genuine pointer exit. The `xterm-hover`
 * class prevents events from falling through to neighboring links.
 */
export function createTerminalLinkHintController(terminal: Terminal): TerminalLinkHintController {
    let activeLinkKey: string | undefined;
    let anchorEvent: MouseEvent | undefined;
    let element: HTMLDivElement | undefined;
    let generation = 0;
    let isLinkHovered = false;
    let modifierChange: ((isModifierDown: boolean) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const host = terminal.element;
    const ownerDocument = host?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;

    const updateModifier = (isModifierDown: boolean) => {
        host?.classList.toggle('terminal-link-modifier-active', isLinkHovered && isModifierDown);
        modifierChange?.(isModifierDown);
    };
    const onKeyboardModifier = (event: KeyboardEvent) => updateModifier(event.metaKey);
    const onWindowBlur = () => updateModifier(false);
    ownerDocument?.addEventListener('keydown', onKeyboardModifier);
    ownerDocument?.addEventListener('keyup', onKeyboardModifier);
    ownerWindow?.addEventListener('blur', onWindowBlur);

    const position = (hintElement: HTMLDivElement, event: MouseEvent) => {
        const bounds = hintElement.getBoundingClientRect();
        const { left, top } = terminalLinkHintPosition(
            terminalLinkHintAnchor(terminal, event),
            { height: bounds.height, width: bounds.width },
            { height: ownerWindow?.innerHeight ?? 0, width: ownerWindow?.innerWidth ?? 0 },
        );
        hintElement.style.left = `${left}px`;
        hintElement.style.top = `${top}px`;
    };

    const hide = () => {
        generation += 1;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        isLinkHovered = false;
        updateModifier(false);
        modifierChange = undefined;
        activeLinkKey = undefined;
        anchorEvent = undefined;
        element?.remove();
        element = undefined;
    };

    return {
        show(event, text, onModifierChange, linkKey = text) {
            if (!host || !ownerDocument || !ownerWindow) return;
            const isSameLink =
                activeLinkKey === linkKey && (timer !== undefined || element?.textContent === text);
            if (!isSameLink) hide();
            activeLinkKey = linkKey;
            anchorEvent = event;
            const currentGeneration = generation;
            isLinkHovered = true;

            if (onModifierChange) {
                modifierChange = (isModifierDown) => {
                    if (generation === currentGeneration) onModifierChange(isModifierDown);
                };
            }
            queueMicrotask(() => {
                if (generation === currentGeneration) updateModifier(event.metaKey);
            });

            if (isSameLink) {
                if (element) position(element, event);
                return;
            }

            timer = setTimeout(() => {
                timer = undefined;
                if (generation !== currentGeneration) return;
                const nextElement = ownerDocument.createElement('div');
                nextElement.className =
                    'xterm-hover terminal-link-hint pointer-events-none fixed z-[90] rounded-md bg-elevated px-2.5 py-1.5 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]';
                nextElement.setAttribute('role', 'tooltip');
                nextElement.style.visibility = 'hidden';
                nextElement.textContent = text;
                host.append(nextElement);
                position(nextElement, anchorEvent ?? event);
                nextElement.style.visibility = 'visible';
                element = nextElement;
            }, TERMINAL_LINK_HINT_DELAY_MS);
        },
        hide,
        leave() {
            isLinkHovered = false;
            updateModifier(false);
            const leavingLinkKey = activeLinkKey;
            queueMicrotask(() => {
                if (!isLinkHovered && activeLinkKey === leavingLinkKey) hide();
            });
        },
        dispose() {
            hide();
            ownerDocument?.removeEventListener('keydown', onKeyboardModifier);
            ownerDocument?.removeEventListener('keyup', onKeyboardModifier);
            ownerWindow?.removeEventListener('blur', onWindowBlur);
            host?.classList.remove('terminal-link-modifier-active');
        },
    };
}
