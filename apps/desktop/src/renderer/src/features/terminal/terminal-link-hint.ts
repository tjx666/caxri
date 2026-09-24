import type { Terminal } from '@xterm/xterm';

import type { TerminalReferencePreviewCard } from './terminal-reference-preview';

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

/**
 * Turns a hover into a preview card. The basic card is drawn immediately from what the Renderer already knows, and
 * `load` — when the reference has metadata only the Server can see — replaces it once the read comes back.
 */
export interface TerminalLinkHintPreview {
    card: TerminalReferencePreviewCard;
    /**
     * Resolves the richer card, or `undefined` to leave the basic one standing. Must never reject: the popup has no way
     * to report a failure the user did not ask for.
     */
    load?(signal: AbortSignal): Promise<TerminalReferencePreviewCard | undefined>;
}

export interface TerminalLinkHintController {
    dispose(): void;
    hide(): void;
    /**
     * Whether xterm currently reports a Caxri-detected link under the pointer, independent of the delayed popup.
     */
    isLinkHovered(): boolean;
    leave(): void;
    show(
        event: MouseEvent,
        text: string,
        onModifierChange?: (isModifierDown: boolean) => void,
        linkKey?: string,
        preview?: TerminalLinkHintPreview,
    ): void;
}

const HINT_LINE_CLASS = 'text-[11px] leading-[1.45] text-muted';
/**
 * Applied only while a card is on screen. The affordance hint is one short sentence and has always been allowed to size
 * itself; a commit body is not, and without a cap the popup stretched to the Terminal's full width and still clipped
 * its last line mid-sentence.
 */
const HINT_CARD_WIDTH_CLASS = 'max-w-[26rem]';

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
    /**
     * The link whose card `Esc` dismissed, held until the pointer moves. xterm reprovides a link on every redraw — a
     * blinking cursor is enough — so without this the popup would reopen half a second later under a pointer the user
     * never moved, and `Esc` would look broken.
     */
    let dismissedLinkKey: string | undefined;
    let element: HTMLDivElement | undefined;
    let generation = 0;
    let isLinkHovered = false;
    let isModifierDown = false;
    let modifierChange: ((isModifierDown: boolean) => void) | undefined;
    let modifierObservedAt: number | undefined;
    let previewRequest: AbortController | undefined;
    /**
     * The affordance line currently on screen. Tracked here rather than read back off the element because a preview
     * card renders that line as one child among several, and a mouse move over the same link must recognize the popup
     * it already opened instead of tearing it down and re-requesting.
     */
    let renderedHintText: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const host = terminal.element;
    const ownerDocument = host?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;

    /**
     * The affordance is hover-scoped, so leaving a link clears it without forgetting that the key is still held.
     */
    const applyModifier = () => {
        const isActive = isLinkHovered && isModifierDown;
        host?.classList.toggle('terminal-link-modifier-active', isActive);
        modifierChange?.(isActive);
    };
    /**
     * A mouse event reports the modifier state as of the last pointer move. When the pointer is still and the user only
     * presses Cmd, xterm reprovides the link with that older event, whose `metaKey` is `false` — accepting it would
     * clear a modifier the user is currently holding, and nothing would correct it until the next key press. So an
     * observation only changes the state when it is at least as recent as the one already recorded. Events without a
     * timestamp cannot be proven stale and are always accepted.
     */
    const observeModifier = (isNextModifierDown: boolean, at: number | undefined) => {
        const isStale =
            at !== undefined && modifierObservedAt !== undefined && at < modifierObservedAt;
        if (!isStale) {
            if (at !== undefined) modifierObservedAt = at;
            isModifierDown = isNextModifierDown;
        }
        applyModifier();
    };
    const onKeyboardModifier = (event: KeyboardEvent) =>
        observeModifier(event.metaKey, event.timeStamp);
    /**
     * A blurred window never delivers the matching `keyup`, so the recorded observation is dropped with the state.
     */
    const onWindowBlur = () => {
        isModifierDown = false;
        modifierObservedAt = undefined;
        applyModifier();
    };
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

    /**
     * Draws one popup. Without a card this stays the single-line affordance hint it has always been, so the plain file
     * and URL links keep their exact previous shape. Every string goes through `textContent`: a commit subject and an
     * issue title are text a stranger wrote, arriving through the one surface in Caxri built to display untrusted
     * output.
     */
    const render = (
        hintElement: HTMLDivElement,
        text: string,
        card: TerminalReferencePreviewCard | undefined,
    ) => {
        hintElement.classList.toggle(HINT_CARD_WIDTH_CLASS, Boolean(card));
        if (!card || !ownerDocument) {
            hintElement.textContent = text;
            return;
        }
        const line = (className: string, value: string) => {
            const node = ownerDocument.createElement('div');
            node.className = className;
            node.textContent = value;
            return node;
        };
        const lines = [line('line-clamp-2 font-medium text-foreground', card.title)];
        if (card.detail) lines.push(line(`${HINT_LINE_CLASS} truncate`, card.detail));
        if (card.facts.length > 0)
            lines.push(line(`${HINT_LINE_CLASS} truncate`, card.facts.join(' \u{00B7} ')));
        if (card.body) lines.push(line(`${HINT_LINE_CLASS} line-clamp-2`, card.body));
        lines.push(line(`${HINT_LINE_CLASS} mt-1.5 border-t border-border pt-1.5`, text));
        hintElement.replaceChildren(...lines);
    };

    const hide = () => {
        generation += 1;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        isLinkHovered = false;
        applyModifier();
        modifierChange = undefined;
        activeLinkKey = undefined;
        anchorEvent = undefined;
        previewRequest?.abort();
        previewRequest = undefined;
        renderedHintText = undefined;
        element?.remove();
        element = undefined;
    };

    /**
     * `Esc` dismisses the popup the way it dismisses every other transient surface, without consuming the key: the
     * Terminal still receives it, because a card the user never asked for must not swallow a keystroke meant for vim.
     *
     * Registered in the capture phase because xterm's own `_keyDown` calls `stopPropagation()` for the keys it claims,
     * `Escape` among them (`use-terminal-pane-runtime.ts` documents the same obstacle for modal dismissal). A
     * bubble-phase listener on `document` would never run while the Terminal holds focus — which is exactly when a
     * Terminal hover card is on screen.
     */
    const onEscape = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        dismissedLinkKey = activeLinkKey;
        hide();
    };
    ownerDocument?.addEventListener('keydown', onEscape, true);
    /**
     * Scrolled-away output takes its popup with it. The card is anchored to a screen row, not to the buffer line it
     * describes, so leaving it up after a scroll would park a commit's details over an unrelated line.
     */
    const scrollDisposable = terminal.onScroll(() => hide());

    return {
        show(event, text, onModifierChange, linkKey = text, preview) {
            if (!host || !ownerDocument || !ownerWindow) return;
            const isSameLink =
                activeLinkKey === linkKey && (timer !== undefined || renderedHintText === text);
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
                if (generation === currentGeneration)
                    observeModifier(event.metaKey, event.timeStamp);
            });

            if (isSameLink) {
                if (element) position(element, event);
                return;
            }
            if (dismissedLinkKey === linkKey) return;
            dismissedLinkKey = undefined;

            timer = setTimeout(() => {
                timer = undefined;
                if (generation !== currentGeneration) return;
                const nextElement = ownerDocument.createElement('div');
                nextElement.className =
                    'xterm-hover terminal-link-hint pointer-events-none fixed z-[90] rounded-md bg-elevated px-2.5 py-1.5 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]';
                nextElement.setAttribute('role', 'tooltip');
                nextElement.style.visibility = 'hidden';
                render(nextElement, text, preview?.card);
                host.append(nextElement);
                position(nextElement, anchorEvent ?? event);
                nextElement.style.visibility = 'visible';
                element = nextElement;
                renderedHintText = text;
                if (!preview?.load) return;
                /**
                 * The request starts only once the popup is actually on screen, so a pointer crossing a screen of
                 * references never spends one read per row it passed over. Its signal is what `hide` aborts.
                 */
                const controller = new AbortController();
                previewRequest = controller;
                const applyPreview = async () => {
                    try {
                        const card = await preview.load?.(controller.signal);
                        if (generation !== currentGeneration || !card) return;
                        render(nextElement, text, card);
                        position(nextElement, anchorEvent ?? event);
                    } catch {
                        // `load` owns its own degradation, so a rejection here can only be a defect in the loader. The
                        // basic card stays up rather than turning a hover into a notification.
                    }
                };
                // eslint-disable-next-line no-void -- the popup is fire-and-forget; `applyPreview` absorbs every failure
                void applyPreview();
            }, TERMINAL_LINK_HINT_DELAY_MS);
        },
        hide,
        isLinkHovered: () => isLinkHovered,
        leave() {
            isLinkHovered = false;
            applyModifier();
            const leavingLinkKey = activeLinkKey;
            queueMicrotask(() => {
                if (isLinkHovered || activeLinkKey !== leavingLinkKey) return;
                // Leaving the link for real is what ends an `Esc` dismissal; a redraw's leave/reprovide pair does not
                // reach here, because the reprovided `show` has already marked the link hovered again.
                dismissedLinkKey = undefined;
                hide();
            });
        },
        dispose() {
            hide();
            ownerDocument?.removeEventListener('keydown', onKeyboardModifier);
            ownerDocument?.removeEventListener('keyup', onKeyboardModifier);
            ownerDocument?.removeEventListener('keydown', onEscape, true);
            ownerWindow?.removeEventListener('blur', onWindowBlur);
            scrollDisposable.dispose();
            host?.classList.remove('terminal-link-modifier-active');
        },
    };
}
