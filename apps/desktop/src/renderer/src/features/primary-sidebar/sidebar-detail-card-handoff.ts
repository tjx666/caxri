import { useSyncExternalStore } from 'react';

import { notifyListeners } from '@caxri/utils';

/**
 * How long a sidebar row's pointer rests before its detail card opens from cold. 450ms read as the card lagging behind
 * the pointer; this is short enough to answer a deliberate hover while a pointer crossing the sidebar on its way
 * elsewhere still opens nothing.
 */
const SIDEBAR_DETAIL_CARD_DELAY_MS = 200;

/**
 * How long after a detail card closes the next one still opens at once. It covers the pointer crossing the gap between
 * two rows, so sweeping down the list swaps cards the way the Codex app's thread list does instead of waiting out the
 * cold delay on every row.
 */
const HANDOFF_WINDOW_MS = 300;

interface Claim {
    close: () => void;
}

const state: {
    current: Claim | undefined;
    isWarm: boolean;
    coolTimer: ReturnType<typeof setTimeout> | undefined;
} = {
    current: undefined,
    isWarm: false,
    coolTimer: undefined,
};
const listeners = new Set<() => void>();

function setWarm(isWarm: boolean): void {
    if (state.isWarm === isWarm) return;
    state.isWarm = isWarm;
    notifyListeners(listeners, undefined);
}

/**
 * Whether a sidebar detail card is open or closed within the handoff window, read at the moment a card opens to decide
 * whether it skips its enter animation.
 */
export function isSidebarDetailCardWarm(): boolean {
    return state.isWarm;
}

/**
 * Registers an open sidebar detail card (Session or Project) as the one shown, closing the previous one at once rather
 * than after its close delay, so a sweep never stacks two cards for a frame of overlap. Returns the release for when
 * the card closes, which keeps the list warm for {@link HANDOFF_WINDOW_MS}.
 */
export function claimSidebarDetailCard(close: () => void): () => void {
    clearTimeout(state.coolTimer);
    state.coolTimer = undefined;
    const claim: Claim = { close };
    const previous = state.current;
    state.current = claim;
    previous?.close();
    setWarm(true);
    return () => {
        if (state.current !== claim) return;
        state.current = undefined;
        state.coolTimer = setTimeout(() => {
            state.coolTimer = undefined;
            setWarm(false);
        }, HANDOFF_WINDOW_MS);
    };
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * The hover delay a sidebar row's detail card trigger uses: none while another card is open or just closed, the cold
 * delay otherwise. It flips twice per hover sweep (first open, cooled down), never per row.
 */
export function useSidebarDetailCardDelay(): number {
    const isWarm = useSyncExternalStore(subscribe, isSidebarDetailCardWarm);
    return isWarm ? 0 : SIDEBAR_DETAIL_CARD_DELAY_MS;
}

/**
 * Popup classes for a sidebar detail card. It closes without the shared exit animation: the card answers "what is under
 * the pointer", and a fading copy of the previous row's card lingering beside the new one only blurred that answer. A
 * card opened while the list is warm also skips the enter animation, so a sweep swaps cards in place; only the first
 * card of a sweep fades in.
 */
export function sidebarDetailCardMotionClassName(isOpenedWarm: boolean): string {
    return isOpenedWarm
        ? 'data-open:animate-none! data-closed:animate-none!'
        : 'data-closed:animate-none!';
}
