/**
 * Where a picker sends keyboard focus when it closes and Base UI has nothing trustworthy to restore it to.
 *
 * Base UI's `FloatingFocusManager` restores focus to, in order: the dialog's trigger, the element focused when the
 * dialog opened, and finally a module-global stack of previously focused elements shared by every dialog in the app.
 * Pickers open from keyboard commands, so they have no trigger; and when the workbench had let focus fall to
 * `document.body` (a click on the Terminal pane's padding, a freshly restored window) the "element focused when the
 * dialog opened" is ignored too. Escape then focuses whatever opened the _previous_ dialog (the sidebar's "Create a
 * Session" button, for instance) with a keyboard focus ring. The workbench registers its own fallback here so the
 * shared stack is never consulted.
 */
const NO_FALLBACK = (): HTMLElement | null => null;
const fallback = { current: NO_FALLBACK };
const restoration = { current: null as Element | null };

export function registerPickerFallbackFocus(getElement: () => HTMLElement | null): () => void {
    fallback.current = getElement;
    return () => {
        if (fallback.current === getElement) fallback.current = NO_FALLBACK;
    };
}

/**
 * Return the exact opening element instead of delegating to Base UI's independently captured focus history.
 */
export function resolvePickerFinalFocus(
    elementFocusedBeforeOpen: HTMLElement | null,
): HTMLElement | false {
    if (
        elementFocusedBeforeOpen?.isConnected &&
        elementFocusedBeforeOpen !== elementFocusedBeforeOpen.ownerDocument.body
    ) {
        return elementFocusedBeforeOpen;
    }
    const element = fallback.current();
    return element?.isConnected ? element : false;
}

/**
 * True only during the synchronous focus event caused by picker restoration, never during later navigation.
 */
export function isRestoringPickerFocus(element: Element): boolean {
    return restoration.current === element;
}

/**
 * Own the focus call so consumers can distinguish restoration from intentional keyboard navigation. Defer until the
 * modal's focus trap has been removed, matching Base UI's cleanup ordering, and opt out of its second focus call. A
 * command that has already handed focus to another surface wins over the old opening element.
 */
export function restorePickerFocus(
    elementFocusedBeforeOpen: HTMLElement | null,
    popup: HTMLElement | null,
): void {
    queueMicrotask(() => {
        const document_ = popup?.ownerDocument ?? elementFocusedBeforeOpen?.ownerDocument;
        if (!document_) return;
        const active = document_.activeElement;
        if (active && active !== document_.body && !popup?.contains(active)) return;
        const target = resolvePickerFinalFocus(elementFocusedBeforeOpen);
        if (!target) return;
        const previous = restoration.current;
        restoration.current = target;
        try {
            target.focus({ preventScroll: true });
        } finally {
            restoration.current = previous;
        }
    });
}
