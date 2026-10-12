import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { agentChatSelectionToolbarPosition } from '../agent-chat-selection';

/**
 * Text selected in a Chat transcript, as a native copy would read it, and the live range the toolbar follows while the
 * transcript scrolls.
 */
export interface AgentChatTranscriptSelection {
    range: Range;
    text: string;
}

/**
 * The document selection when it starts or ends inside `content` and holds more than whitespace. The transcript is
 * `select-none` except message text, reasoning, and output bodies, and a drag that ends on chrome below the last reply
 * (its time, the composer's padding) leaves the selection's other end outside the transcript, so one end inside is
 * enough. The text is the selection's own, which skips unselectable chrome; a Range's text or cloned markup would not.
 */
function readTranscriptSelection(
    content: HTMLElement | null,
): AgentChatTranscriptSelection | undefined {
    const selection = getSelection();
    if (!content || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const { anchorNode, focusNode } = selection;
    if (
        !(anchorNode && content.contains(anchorNode)) &&
        !(focusNode && content.contains(focusNode))
    )
        return;
    const text = selection.toString().trimEnd();
    if (!text.trim()) return;
    return { range: selection.getRangeAt(0), text };
}

/**
 * The selection's first and last line boxes inside `content`, so a selection that runs on past the transcript is placed
 * against the text the user sees selected.
 */
function lineBoxes(range: Range, content: HTMLElement): { first: DOMRect; last: DOMRect } {
    const area = content.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter(
        (rect) =>
            rect.width > 0 && rect.height > 0 && rect.top >= area.top && rect.bottom <= area.bottom,
    );
    const whole = range.getBoundingClientRect();
    return { first: rects[0] ?? whole, last: rects.at(-1) ?? whole };
}

/**
 * The toolbar that floats over text selected in a Chat transcript (see `AgentChatSelectionToolbar`). It appears when
 * the pointer that made the selection is released, as in Synara, LibreChat, and assistant-ui, so a drag in progress
 * never has a toolbar jumping along with it, and it leaves when the selection collapses or moves out of the transcript,
 * on Escape, and on a press outside it. While shown it follows the selection as the transcript scrolls or resizes, and
 * hides while the selection is scrolled out of view.
 */
export function useAgentChatSelectionToolbar(
    contentReference: RefObject<HTMLElement | null>,
    scrollReference: RefObject<HTMLElement | null>,
) {
    const toolbarReference = useRef<HTMLDivElement | null>(null);
    const [selection, setSelection] = useState<AgentChatTranscriptSelection>();
    const dismiss = useCallback(() => setSelection(undefined), []);
    /**
     * Placing the toolbar writes its style directly: it follows every scroll frame, which would otherwise re-render the
     * toolbar once per frame, and it has to measure the toolbar it moves.
     */
    useLayoutEffect(() => {
        const toolbar = toolbarReference.current;
        const view = scrollReference.current;
        const content = contentReference.current;
        if (!selection || !toolbar || !view || !content) return;
        const place = (): void => {
            const bounds = view.getBoundingClientRect();
            // A Chat kept alive behind another Session or tab lays out at zero size.
            const position =
                bounds.height > 0
                    ? agentChatSelectionToolbarPosition({
                          bounds,
                          ...lineBoxes(selection.range, content),
                          size: { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
                      })
                    : undefined;
            toolbar.style.visibility = position ? 'visible' : 'hidden';
            if (position) {
                toolbar.style.top = `${position.top}px`;
                toolbar.style.left = `${position.left}px`;
            }
        };
        place();
        // Following the selection needs its line boxes on every scroll; no observer reports where a Range moved.
        // eslint-disable-next-line unicorn/prefer-observer-apis -- see above
        view.addEventListener('scroll', place, { passive: true });
        const observer = new ResizeObserver(place);
        observer.observe(view);
        return () => {
            view.removeEventListener('scroll', place);
            observer.disconnect();
        };
    }, [contentReference, scrollReference, selection]);
    useEffect(() => {
        let frame = 0;
        const onPointerUp = (event: PointerEvent): void => {
            if (event.button !== 0 || toolbarReference.current?.contains(event.target as Node))
                return;
            // The selection settles after the pointer is released: a click inside a selection collapses it only then.
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() =>
                setSelection(readTranscriptSelection(contentReference.current)),
            );
        };
        const onPointerDown = (event: PointerEvent): void => {
            if (!toolbarReference.current?.contains(event.target as Node)) setSelection(undefined);
        };
        const onSelectionChange = (): void => {
            setSelection((current) =>
                current && readTranscriptSelection(contentReference.current)?.text === current.text
                    ? current
                    : undefined,
            );
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setSelection(undefined);
        };
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointerdown', onPointerDown, { capture: true });
        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('selectionchange', onSelectionChange);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [contentReference]);
    return { dismiss, selection, toolbarReference };
}
