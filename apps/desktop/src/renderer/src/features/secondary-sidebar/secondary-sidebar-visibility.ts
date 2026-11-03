import { useChromeLayoutStore } from '../../stores/chrome-layout';

/**
 * Whether the SecondarySidebar is on screen: its stored preference, unless Zen mode hides it. Every consumer that lays
 * out around it reads this rather than the stored flag.
 */
export function useIsSecondarySidebarShown(): boolean {
    return useChromeLayoutStore((state) => !state.zenMode && state.secondarySidebarVisible);
}

function isSecondarySidebarShown(): boolean {
    const state = useChromeLayoutStore.getState();
    return !state.zenMode && state.secondarySidebarVisible;
}

/**
 * `Cmd+]`: toggles the SecondarySidebar, leaving Zen mode first when Zen hides it.
 */
export function toggleSecondarySidebar(): void {
    useChromeLayoutStore.getState().toggleSecondarySidebar();
}

/**
 * Shows the SecondarySidebar for a command that selects one of its views.
 */
export function revealSecondarySidebar(): void {
    if (isSecondarySidebarShown()) return;
    useChromeLayoutStore.getState().setSecondarySidebarVisible(true);
}
