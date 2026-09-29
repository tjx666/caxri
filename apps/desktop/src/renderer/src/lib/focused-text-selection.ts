interface TextSelectionSource {
    element: HTMLElement;
    read: () => string;
}

const sources = new Set<TextSelectionSource>();

/**
 * Registers a surface whose selection the DOM cannot see. Monaco keeps its selection in its own model behind a hidden
 * textarea, and xterm paints its selection onto a canvas, so `window.getSelection()` reports nothing for either; the
 * surface lends a reader instead, consulted while focus is inside `element`.
 */
export function registerTextSelectionSource(element: HTMLElement, read: () => string): () => void {
    const source = { element, read };
    sources.add(source);
    return () => sources.delete(source);
}

/**
 * The text the user has selected in the focused surface: a registered editor or Terminal first, the DOM selection
 * otherwise. Empty when nothing is selected.
 */
export function focusedTextSelection(): string {
    const active = document.activeElement;
    if (active)
        for (const source of sources) if (source.element.contains(active)) return source.read();
    return getSelection()?.toString() ?? '';
}
