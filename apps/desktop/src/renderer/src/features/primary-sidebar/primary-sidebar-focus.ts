import { focusChromeSurface } from '../../stores/chrome-focus-handoff';
import { useChromeLayoutStore } from '../../stores/chrome-layout';

/**
 * Moves keyboard focus into the Primary Side Bar's Session tree, revealing the side bar first when it is hidden.
 *
 * Showing the side bar has never moved focus into it, so reaching the Session tree meant Tabbing there from whatever
 * owned focus — and the surface that usually owns focus is a Terminal, which swallows Tab. This is the only entry point
 * that does not depend on where focus already is.
 *
 * Where focus lands is the shared chrome rule, not a second one: `focusChromeSurface` owns every surface's keyboard
 * entry point and the one-frame wait that reveal needs, so the Panel, the Secondary Side Bar, and this command cannot
 * drift apart on what "focus the side bar" means.
 */
export function focusPrimarySidebar(): void {
    const layout = useChromeLayoutStore.getState();
    if (!layout.primarySidebarVisible) layout.setPrimarySidebarVisible(true);
    focusChromeSurface('primarySidebar');
}
