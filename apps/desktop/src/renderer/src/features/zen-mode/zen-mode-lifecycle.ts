import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { useWorkbenchStore } from '../../stores/workbench';
import { didRequestWindowFullScreen } from './zen-mode-commands';

const STORAGE_KEY = 'caxri.zen-mode';

/**
 * What Zen Mode keeps across a restart. `enteredFullScreen` records that Zen, not the user, put the window in full
 * screen, so leaving Zen after a restart still gives the screen back. Device-local like the chrome layout it overlays.
 */
export interface PersistedZenMode {
    isActive: boolean;
    enteredFullScreen: boolean;
}

export function parsePersistedZenMode(raw: unknown): PersistedZenMode {
    const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<PersistedZenMode>;
    const isActive = value.isActive === true;
    return { isActive, enteredFullScreen: isActive && value.enteredFullScreen === true };
}

export interface ZenFullScreenPlan {
    /**
     * The state to request from Main, or `undefined` when the window should stay as it is.
     */
    setFullScreen?: boolean;
    enteredFullScreen: boolean;
}

/**
 * Decides what Zen does to the native full screen when it turns on or off. Zen only gives back a full screen it took: a
 * window the user already had in full screen stays there when Zen ends, as in VS Code.
 */
export function planZenFullScreen(
    transition: 'enter' | 'leave',
    state: { isEnabled: boolean; isFullScreen: boolean; enteredFullScreen: boolean },
): ZenFullScreenPlan {
    if (transition === 'enter') {
        const shouldEnter = state.isEnabled && !state.isFullScreen;
        return shouldEnter
            ? { setFullScreen: true, enteredFullScreen: true }
            : { enteredFullScreen: false };
    }
    return state.enteredFullScreen
        ? { setFullScreen: false, enteredFullScreen: false }
        : { enteredFullScreen: false };
}

/**
 * Wires Zen Mode to the native window: enters full screen with Zen (`zen.fullScreen`), gives it back when Zen ends by
 * any path (toggle, a surface reveal, the exit button), and restores Zen after a restart (`zen.restore`). Subscribing
 * to the store, rather than wrapping the toggle command, is what covers every path that clears `zenMode`.
 */
export function startZenModeLifecycle(options: {
    isFullScreenEnabled: () => boolean;
    isRestoreEnabled: () => boolean;
}): () => void {
    const persisted = parsePersistedZenMode(readLocalStorageJson(STORAGE_KEY));
    let isEnteredFullScreen = false;
    const persist = (): void => {
        writeLocalStorageJson(STORAGE_KEY, {
            isActive: useChromeLayoutStore.getState().zenMode,
            enteredFullScreen: isEnteredFullScreen,
        } satisfies PersistedZenMode);
    };
    const requestFullScreen = async (isFullScreen: boolean): Promise<void> => {
        const isApplied = await didRequestWindowFullScreen(isFullScreen);
        if (isApplied || !isFullScreen) return;
        isEnteredFullScreen = false;
        persist();
    };

    if (options.isRestoreEnabled() && persisted.isActive) {
        // Main restores the window's own full screen state, so Zen only has to remember that it owned it.
        isEnteredFullScreen = persisted.enteredFullScreen;
        useChromeLayoutStore.getState().toggleZenMode();
    } else {
        persist();
    }

    const unsubscribeZen = useChromeLayoutStore.subscribe((state, previous) => {
        if (state.zenMode === previous.zenMode) return;
        const plan = planZenFullScreen(state.zenMode ? 'enter' : 'leave', {
            isEnabled: options.isFullScreenEnabled(),
            isFullScreen: useWorkbenchStore.getState().isFullScreen,
            enteredFullScreen: isEnteredFullScreen,
        });
        isEnteredFullScreen = plan.enteredFullScreen;
        if (plan.setFullScreen !== undefined) void requestFullScreen(plan.setFullScreen);
        persist();
    });
    // The user leaving full screen by hand during Zen ends Zen's claim on it, so a later full screen they enter
    // themselves is not taken away when Zen ends.
    const unsubscribeFullScreen = useWorkbenchStore.subscribe((state, previous) => {
        if (!isEnteredFullScreen || state.isFullScreen || !previous.isFullScreen) return;
        isEnteredFullScreen = false;
        persist();
    });
    return () => {
        unsubscribeZen();
        unsubscribeFullScreen();
    };
}
