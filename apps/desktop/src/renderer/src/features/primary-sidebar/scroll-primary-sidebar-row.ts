/**
 * Scrolls one PrimarySidebar tree row into view after a reveal opened its group. Two frames: the expanded group and the
 * widened Session window render first, then the row exists to scroll to.
 */
export function scrollPrimarySidebarRowIntoView(rowId: string): void {
    requestAnimationFrame(() =>
        requestAnimationFrame(() =>
            document
                .querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`)
                ?.scrollIntoView({ block: 'nearest' }),
        ),
    );
}
