/**
 * Where a picker sends keyboard focus when it closes and Base UI has nothing trustworthy to restore it to.
 *
 * Base UI's `FloatingFocusManager` restores focus to, in order: the dialog's trigger, the element focused when the
 * dialog opened, and finally a module-global stack of previously focused elements shared by every dialog in the app.
 * Pickers open from keyboard commands, so they have no trigger; and when the workbench had let focus fall to
 * `document.body` (a click on the Terminal pane's padding, a freshly restored window) the "element focused when the
 * dialog opened" is ignored too. Escape then focuses whatever opened the _previous_ dialog — the sidebar's "Create a
 * Session" button, for instance — with a keyboard focus ring. The workbench registers its own fallback here so the
 * shared stack is never consulted.
 */
const NO_FALLBACK = (): HTMLElement | null => null;
const fallback = { current: NO_FALLBACK };

export function registerPickerFallbackFocus(getElement: () => HTMLElement | null): () => void {
    fallback.current = getElement;
    return () => {
        if (fallback.current === getElement) fallback.current = NO_FALLBACK;
    };
}

/**
 * Value for Base UI's `finalFocus`: `true` lets it restore the element that held focus when the picker opened, an
 * element overrides that, and `false` leaves focus where the closing dialog dropped it rather than on a stale element.
 */
export function resolvePickerFinalFocus(
    elementFocusedBeforeOpen: Element | null,
): HTMLElement | true | false {
    if (
        elementFocusedBeforeOpen?.isConnected &&
        elementFocusedBeforeOpen !== elementFocusedBeforeOpen.ownerDocument.body
    ) {
        return true;
    }
    return fallback.current() ?? false;
}
