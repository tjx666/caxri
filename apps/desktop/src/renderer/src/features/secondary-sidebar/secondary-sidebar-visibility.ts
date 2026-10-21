import { useEffect } from 'react';

import type { BootstrapState } from '@caxri/protocol';

import { isSecondarySidebarShownFor, useChromeLayoutStore } from '../../stores/chrome-layout';
import { getBootstrap } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';
import { hasBesideChatArrangement } from '../agent-chat/tasks/beside-chat-layout';

/**
 * The scope the SecondarySidebar yields in: the selected Session and its Workbench Root, while that layout shows a pane
 * beside its Chat. A reveal made in one scope does not carry into another Session or Root.
 */
function secondarySidebarYieldScope(bootstrap: BootstrapState | undefined): string | undefined {
    const session = bootstrap?.sessions.find(({ id }) => id === bootstrap.selectedSessionId);
    if (!session) return undefined;
    const layout = bootstrap?.sessionStates.find(
        (state) => state.sessionId === session.id,
    )?.paneLayout;
    if (!layout || !hasBesideChatArrangement(layout)) return undefined;
    return `${session.id}:${session.workbenchProjectId}`;
}

export function getSecondarySidebarYieldScope(): string | undefined {
    return secondarySidebarYieldScope(getBootstrap());
}

/**
 * Whether the SecondarySidebar is on screen; every consumer that lays out around it reads this rather than the stored
 * flag. Read in the same render as the Session layout, so opening a pane beside a Chat and the SecondarySidebar
 * stepping aside commit together and the Terminal resizes once.
 */
export function useIsSecondarySidebarShown(): boolean {
    const yieldScope = useWorkbenchStore((state) => secondarySidebarYieldScope(state.bootstrap));
    return useChromeLayoutStore((state) =>
        isSecondarySidebarShownFor(
            state.secondarySidebarVisible,
            yieldScope,
            state.secondarySidebarRevealedScope,
        ),
    );
}

export function isSecondarySidebarShown(): boolean {
    const state = useChromeLayoutStore.getState();
    return isSecondarySidebarShownFor(
        state.secondarySidebarVisible,
        getSecondarySidebarYieldScope(),
        state.secondarySidebarRevealedScope,
    );
}

/**
 * `Cmd+]`: toggles what is on screen, so it reveals a yielding SecondarySidebar instead of hiding the stored
 * preference.
 */
export function toggleSecondarySidebar(): void {
    useChromeLayoutStore.getState().toggleSecondarySidebar(getSecondarySidebarYieldScope());
}

/**
 * Shows the SecondarySidebar for a command that selects one of its views, overriding a yield in the current scope.
 */
export function revealSecondarySidebar(): void {
    if (isSecondarySidebarShown()) return;
    useChromeLayoutStore
        .getState()
        .setSecondarySidebarVisible(true, getSecondarySidebarYieldScope());
}

/**
 * Ends a reveal once its arrangement is gone (the side pane closed, or another Session or Root selected), and re-fits
 * the widths a returning SecondarySidebar reserves again.
 */
export function useSecondarySidebarYieldSync(): void {
    const yieldScope = useWorkbenchStore((state) => secondarySidebarYieldScope(state.bootstrap));
    useEffect(() => {
        const store = useChromeLayoutStore.getState();
        store.syncSecondarySidebarYieldScope(yieldScope);
        store.clampToViewport(window.innerWidth, window.innerHeight, yieldScope);
    }, [yieldScope]);
}
