import { lastSourceScroll, subscribeSourceScroll } from './preview-scroll-sync';

export interface PreviewScrollAnchor {
    /**
     * Zero-based source line of the block, as reported by the Markdown engine.
     */
    line: number;
    /**
     * Offset of the block inside the scrolling container.
     */
    top: number;
}

/**
 * Reads the position of every top-level block the engine annotated with its source line.
 *
 * Collected once per render because each entry forces layout; the source editor then scrolls many times against the
 * same table.
 */
function collectScrollAnchors(container: HTMLElement): PreviewScrollAnchor[] {
    const anchors: PreviewScrollAnchor[] = [];
    for (const element of container.querySelectorAll('[data-line]')) {
        if (!(element instanceof HTMLElement)) continue;
        const line = Number(element.dataset.line);
        if (!Number.isSafeInteger(line)) continue;
        anchors.push({ line, top: element.offsetTop - container.offsetTop });
    }
    return anchors;
}

/**
 * Where the preview has to scroll so `line` sits at its top edge.
 *
 * Only whole blocks carry a position, so a line inside one is placed by interpolating between the block that starts at
 * or before it and the next one — the same approximation VS Code's Markdown preview uses, and the reason a long
 * paragraph tracks smoothly instead of jumping at its boundaries.
 */
export function previewScrollTop(anchors: readonly PreviewScrollAnchor[], line: number): number {
    if (anchors.length === 0) return 0;
    const first = anchors[0];
    if (line <= first.line) return first.top;
    let low = 0;
    let high = anchors.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (anchors[middle].line <= line) low = middle;
        else high = middle - 1;
    }
    const previous = anchors[low];
    const next = anchors.at(low + 1);
    if (!next || next.line <= previous.line) return previous.top;
    const progress = (line - previous.line) / (next.line - previous.line);
    return previous.top + progress * (next.top - previous.top);
}

/**
 * Keeps the preview aligned with the source editor.
 *
 * The link is deliberately one-way: the editor is where the user is working, so it drives and the preview follows. A
 * two-way link has to arbitrate which side moved first on every frame, and gets it wrong exactly when the user is
 * scrolling one side quickly.
 */
export function followSourceScroll(container: HTMLElement, documentPath: string): () => void {
    const state = { anchors: collectScrollAnchors(container), frame: 0 };
    const scrollTo = (line: number): void => {
        cancelAnimationFrame(state.frame);
        state.frame = requestAnimationFrame(() => {
            container.scrollTop = previewScrollTop(state.anchors, line);
        });
    };
    const initial = lastSourceScroll(documentPath);
    if (initial !== undefined) scrollTo(initial);
    const unsubscribe = subscribeSourceScroll(documentPath, scrollTo);
    return () => {
        cancelAnimationFrame(state.frame);
        unsubscribe();
    };
}
