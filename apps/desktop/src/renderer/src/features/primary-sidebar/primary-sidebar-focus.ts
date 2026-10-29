import { focusChromeSurface } from '../../stores/chrome-focus-handoff';
import { isPrimarySidebarShown, useChromeLayoutStore } from '../../stores/chrome-layout';

/**
 * Moves keyboard focus into the Primary Side Bar's Session tree, revealing the side bar first when it is hidden.
 *
 * Showing the side bar has never moved focus into it, so reaching the Session tree meant Tabbing there from whatever
 * owned focus, and the surface that usually owns focus is a Terminal, which swallows Tab. This is the only entry point
 * that does not depend on where focus already is.
 *
 * Where focus lands is the shared chrome rule, not a second one: `focusChromeSurface` owns every surface's keyboard
 * entry point and the one-frame wait that reveal needs, so the Panel, the Secondary Side Bar, and this command cannot
 * drift apart on what "focus the side bar" means.
 */
export function focusPrimarySidebar(): void {
    const layout = useChromeLayoutStore.getState();
    if (!isPrimarySidebarShown(layout)) layout.setPrimarySidebarVisible(true);
    focusChromeSurface('primarySidebar');
}

/**
 * Hands focus from a group heading's disclosure chevron to the heading's own `treeitem`, its sibling. The chevron is a
 * pointer target only (`tabIndex={-1}`), yet a click still focuses it, and a focused chevron is a focus owner inside
 * `role="tree"` that the tree's arrow keys and roving Tab stop do not know, since both key off the rows (issue #1012).
 * Clicking the row itself already focuses it; the chevron now ends in the same place.
 */
export function focusDisclosureRow(disclosure: HTMLElement): void {
    disclosure.parentElement?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
}
