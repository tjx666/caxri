import { notifyListeners } from '@caxri/utils';
import type { BrowserWindow } from 'electron';

/**
 * How SSH Host environments reach the primary Workbench window, which every machine's records share: they deliver their
 * events to it, and each re-registers its presence there whenever a new primary window opens (a dock reopen after the
 * window was closed).
 */
export interface PrimaryWindowChannel {
    deliver(environmentId: string, message: unknown): void;
    observe(listener: (window: BrowserWindow) => void): () => void;
    /**
     * Called by Main once it created a new primary window.
     */
    opened(window: BrowserWindow): void;
}

export function createPrimaryWindowChannel(
    window: () => BrowserWindow | undefined,
): PrimaryWindowChannel {
    const listeners = new Set<(window: BrowserWindow) => void>();
    const live = (): BrowserWindow | undefined => {
        const current = window();
        return current && !current.isDestroyed() ? current : undefined;
    };
    return {
        deliver(environmentId, message) {
            live()?.webContents.send('caxri:environment-event', environmentId, message);
        },
        observe(listener) {
            const current = live();
            if (current) listener(current);
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        opened(opened) {
            notifyListeners(listeners, opened);
        },
    };
}
