import type { ServerEvent } from '@caxri/protocol';

import type { EventAudience } from './event-audience';
import { PRIMARY_WINDOW_KEY } from './window-presence-registry';

/**
 * The IPC sender (a window's `webContents`) a Workbench window is identified by.
 */
export type WorkbenchSender = WorkbenchWindowLike['webContents'];

/**
 * The slice of `BrowserWindow` the registry reads, so it runs under Vitest without Electron.
 */
export interface WorkbenchWindowLike {
    isDestroyed(): boolean;
    isFocused(): boolean;
    webContents: { send(channel: string, ...arguments_: unknown[]): void };
}

/**
 * Every live local Workbench window by key: the primary window (`main`) and the tear-off windows Main minted.
 *
 * Trust follows membership: only a registered window's `webContents` may send Workbench IPC. A tear-off window leaves
 * the registry when it closes, so a request already queued behind its close cannot recreate the strip the close just
 * released. The primary window's sender stays trusted until process exit (see {@link WorkbenchWindows.remove}).
 */
export class WorkbenchWindows<W extends WorkbenchWindowLike = WorkbenchWindowLike> {
    private readonly windows = new Map<string, W>();
    private readonly keys = new WeakMap<object, string>();

    add(windowKey: string, window: W): void {
        this.windows.set(windowKey, window);
        this.keys.set(window.webContents, windowKey);
    }

    /**
     * Forgets a closed window. With `keepSenderTrust` the window's `webContents` stays a trusted sender: an explicit
     * quit closes the primary window before its already-queued IPC reaches Main, and that IPC must still resolve its
     * key.
     */
    remove(windowKey: string, options: { keepSenderTrust?: boolean } = {}): void {
        const window = this.windows.get(windowKey);
        if (!window) return;
        this.windows.delete(windowKey);
        if (!options.keepSenderTrust) this.keys.delete(window.webContents);
    }

    get(windowKey: string): W | undefined {
        const window = this.windows.get(windowKey);
        return window && !window.isDestroyed() ? window : undefined;
    }

    primary(): W | undefined {
        return this.get(PRIMARY_WINDOW_KEY);
    }

    /**
     * The key a Workbench IPC sender acts under, or `undefined` for a sender that is not a Workbench window.
     */
    keyOf(sender: WorkbenchSender): string | undefined {
        return this.keys.get(sender);
    }

    isWorkbenchSender(sender: WorkbenchSender): boolean {
        return this.keyOf(sender) !== undefined;
    }

    /**
     * The live windows, primary first, then tear-offs in the order they opened.
     */
    list(): Array<{ key: string; window: W }> {
        return [...this.windows]
            .filter(([, window]) => !window.isDestroyed())
            .map(([key, window]) => ({ key, window }))
            .toSorted(
                (a, b) =>
                    Number(b.key === PRIMARY_WINDOW_KEY) - Number(a.key === PRIMARY_WINDOW_KEY),
            );
    }

    /**
     * The window with native keyboard focus, else the primary window: the audience of a menu command.
     */
    focusedOrPrimary(): W | undefined {
        return this.list().find(({ window }) => window.isFocused())?.window ?? this.primary();
    }
}

/**
 * Builds the delivery function the event relay uses for the Workbench audience: `all` reaches every window, `focused`
 * the window with keyboard focus (else the primary), and `target` the window the sender named (else the primary). An
 * explicit `windowKey` always wins, which is how a retained notice reaches the one window that just became ready.
 */
export function createWorkbenchEventDelivery(
    windows: Pick<WorkbenchWindows, 'focusedOrPrimary' | 'get' | 'list' | 'primary'>,
    audienceOf: (event: ServerEvent) => EventAudience,
): (message: unknown, event: ServerEvent, windowKey?: string) => void {
    return (message, event, windowKey) => {
        const targets = windowKey
            ? [windows.get(windowKey)]
            : audienceOf(event) === 'all'
              ? windows.list().map(({ window }) => window)
              : [audienceOf(event) === 'focused' ? windows.focusedOrPrimary() : windows.primary()];
        for (const window of targets) window?.webContents.send('caxri:event', message);
    };
}
