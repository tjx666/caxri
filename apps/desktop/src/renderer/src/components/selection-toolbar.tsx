import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

export const SELECTION_TOOLBAR_BUTTON_CLASS_NAME =
    'flex h-6 cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent px-2 text-[12px] text-foreground hover:bg-[var(--selection)] focus-visible:outline focus-visible:outline-accent';

/**
 * The floating pill of actions over selected text (a Chat transcript's Copy and Add to message, an editor's Add to
 * Chat). The owning hook measures it and writes its `top`/`left` (see `selectionToolbarPosition`), so it starts hidden
 * at the viewport origin. It refuses the press that would collapse the selection its buttons act on.
 */
export function SelectionToolbar({
    children,
    label,
    toolbarReference,
}: {
    children: ReactNode;
    label: string;
    toolbarReference: RefObject<HTMLDivElement | null>;
}) {
    return createPortal(
        <div
            aria-label={label}
            // Hidden until the owning hook measures and places it; it then fades in on the overlay enter timing in
            // place, as the Codex app's selection actions do, and leaves instantly so it never lingers over the text
            // the user moves on to. `duration-*` also sets `transition-duration`, and `transition-property` defaults to
            // `all`, so without `transition-none` the first placement would glide in from the viewport's top-left corner.
            className="motion-safe:animate-in motion-safe:fade-in-0 invisible fixed top-0 left-0 z-[80] flex items-center gap-0.5 rounded-md bg-elevated p-0.5 shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] transition-none duration-(--motion-overlay-enter) ease-(--motion-ease-enter)"
            ref={toolbarReference}
            role="toolbar"
            onPointerDown={(event) => event.preventDefault()}
        >
            {children}
        </div>,
        document.body,
    );
}
