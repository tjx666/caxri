import { AsyncLocalStorage } from 'node:async_hooks';

import type { CaxriMethod, WindowPresenceReport, WindowPresenceSeed } from '@caxri/protocol';
import { errorMessage, isWindowScopedMethod } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { DesktopServerConnection } from './server-connection';

/**
 * The key of the Workbench window of an environment. The local Desktop has one Workbench window today, and each SSH
 * Host window has its own Server connection, so the key only has to be stable across restarts: the Server persists that
 * window's Open Sessions under it. Tear-off windows will mint additional keys.
 */
export const PRIMARY_WINDOW_KEY = 'main';

/**
 * The native events that change what a window reports. `focus` and `blur` follow keyboard focus; the rest follow
 * whether the window is on screen.
 */
const PRESENCE_EVENTS = ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const;

/**
 * The slice of `BrowserWindow` presence needs, so the registry runs under Vitest without Electron.
 */
export interface PresenceWindow {
    isDestroyed(): boolean;
    isFocused(): boolean;
    isMinimized(): boolean;
    isVisible(): boolean;
    on(event: (typeof PRESENCE_EVENTS)[number] | 'closed', listener: () => void): unknown;
}

interface WindowPresenceRegistryOptions {
    now?: () => number;
    /**
     * Reports a failure other than the connection being between attachments, which the reseed already covers.
     */
    onSendError?: (error: unknown) => void;
    /**
     * Forgets a closed window on the Server this registry's windows belong to.
     */
    closePresence: (windowKey: string) => Promise<unknown>;
    /**
     * Sends one presence row to the Server this registry's windows belong to.
     */
    reportPresence: (report: WindowPresenceReport) => Promise<unknown>;
}

interface PresenceEntry {
    focusedAt: number;
    viewingSessionId: string | null;
    window: PresenceWindow;
}

/**
 * What the key of the window that sent the request currently being handled is. The command dispatcher is
 * transport-neutral and its execution context carries no Electron objects, so Main reads the sender's window key from
 * here when it forwards a request to the Server and when a Main method needs the caller's window.
 */
const requestWindowKey = new AsyncLocalStorage<string>();

export function runInRequestWindowKey<T>(windowKey: string | undefined, run: () => T): T {
    return windowKey === undefined ? run() : requestWindowKey.run(windowKey, run);
}

export function currentRequestWindowKey(): string | undefined {
    return requestWindowKey.getStore();
}

/**
 * Adds the sender's window key to a request that acts for a window and passes every other request through untouched.
 * The key is always overwritten: a Renderer is never trusted to name its window.
 */
export function withWindowKey(method: string, parameters: unknown, windowKey: string | undefined) {
    if (windowKey === undefined || !isWindowScopedMethod(method)) return parameters;
    const base =
        typeof parameters === 'object' && parameters !== null
            ? (parameters as Record<string, unknown>)
            : {};
    return { ...base, windowKey };
}

/**
 * Main's view of the windows of one Server connection, and the only writer of their presence on that Server. Native
 * focus, visibility, and minimize state are read from the window itself, never from the Renderer, so a minimized or
 * occluded window cannot claim to be watched; the Renderer contributes only which Session it renders.
 *
 * It owns three jobs: report a window whenever one of its facts changes, hand a connection that is re-attaching one
 * atomic snapshot of every live window before that connection serves any request, and answer "is this Session being
 * looked at right now" for notification suppression by reading the live native state.
 *
 * Its cost is one small request per focus, visibility, or navigation change, with no timers and no polling.
 */
export class WindowPresenceRegistry {
    private readonly entries = new Map<string, PresenceEntry>();
    /**
     * Identity survives the window: a request already queued when the window closes (an explicit quit closes it before
     * its IPC drains) must still resolve to the same key.
     */
    private readonly keys = new WeakMap<WeakKey, string>();
    /**
     * Bumped on every change a snapshot could miss, so a reseed that raced a change can tell and send again.
     */
    private revision = 0;

    constructor(private readonly options: WindowPresenceRegistryOptions) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private row(windowKey: string, entry: PresenceEntry): WindowPresenceReport {
        const { window } = entry;
        const isLive = !window.isDestroyed();
        const isVisible = isLive && window.isVisible() && !window.isMinimized();
        return {
            windowKey,
            viewingSessionId: entry.viewingSessionId,
            focused: isVisible && window.isFocused(),
            visible: isVisible,
        };
    }

    private publish(windowKey: string): void {
        this.revision += 1;
        const entry = this.entries.get(windowKey);
        if (!entry) return;
        const report = this.row(windowKey, entry);
        this.fireAndForget(() => this.options.reportPresence(report));
    }

    /**
     * A failed row is not retried: the connection reseeds every live window when it re-attaches.
     */
    private fireAndForget(task: () => Promise<unknown>): void {
        // `Promise.try` makes a synchronous throw (the connection object not existing yet) a rejection too.
        // eslint-disable-next-line no-void -- failures are routed to `onSendError`
        void Promise.try(task).catch((error: unknown) => {
            if (!isUnavailable(error)) this.options.onSendError?.(error);
        });
    }

    private snapshot(): WindowPresenceSeed['windows'] {
        return [...this.entries].map(([windowKey, entry]) => ({
            ...this.row(windowKey, entry),
            focusedAt: entry.focusedAt,
        }));
    }

    /**
     * Starts tracking `window` under `windowKey`, with `owner` (its `WebContents`) as the identity IPC senders resolve
     * through {@link keyOf}. Registering a key again replaces the window, which is how the local Workbench reopens after
     * it was closed.
     */
    register(windowKey: string, owner: WeakKey, window: PresenceWindow): void {
        this.keys.set(owner, windowKey);
        const entry: PresenceEntry = {
            focusedAt: window.isFocused() ? this.now() : 0,
            viewingSessionId: null,
            window,
        };
        this.entries.set(windowKey, entry);
        for (const event of PRESENCE_EVENTS)
            window.on(event, () => {
                if (this.entries.get(windowKey) !== entry) return;
                if (event === 'focus') entry.focusedAt = this.now();
                this.publish(windowKey);
            });
        window.on('closed', () => {
            if (this.entries.get(windowKey) !== entry) return;
            this.entries.delete(windowKey);
            this.revision += 1;
            this.fireAndForget(() => this.options.closePresence(windowKey));
        });
        this.publish(windowKey);
    }

    /**
     * The key of the window an IPC sender belongs to, or `undefined` for a sender this registry never registered.
     */
    keyOf(owner: WeakKey): string | undefined {
        return this.keys.get(owner);
    }

    /**
     * Records the Session a window renders, as its Renderer reported it. A repeat of the current value sends nothing.
     */
    setViewing(windowKey: string, sessionId: string | null): void {
        const entry = this.entries.get(windowKey);
        if (!entry || entry.viewingSessionId === sessionId) return;
        entry.viewingSessionId = sessionId;
        this.publish(windowKey);
    }

    /**
     * True only when some window renders `sessionId` and is focused, visible, and not minimized right now. It reads the
     * native state at call time rather than the last report and never falls back to the most recently focused window,
     * so a notification is suppressed only for a Session the user can actually see.
     */
    isSessionShown(sessionId: string): boolean {
        for (const [windowKey, entry] of this.entries) {
            if (entry.viewingSessionId !== sessionId) continue;
            const row = this.row(windowKey, entry);
            if (row.focused && row.visible) return true;
        }
        return false;
    }

    /**
     * Sends every live window to a connection that is attaching, as one snapshot that replaces whatever that connection
     * held. A change that lands while the snapshot is in flight is dropped by the not-yet-attached connection, so the
     * snapshot is rebuilt and resent until none raced it. The caller awaits this before the connection serves requests,
     * which is what keeps the Server from acting on an empty or half-seeded view after a restart or reconnect.
     */
    async seed(
        sendSeed: (parameters: WindowPresenceSeed) => Promise<unknown>,
        maxAttempts = 5,
    ): Promise<void> {
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const revision = this.revision;
            // eslint-disable-next-line no-await-in-loop -- each snapshot must land before a racing change is checked
            await sendSeed({ windows: this.snapshot() });
            if (revision === this.revision) return;
        }
    }
}

function isUnavailable(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'UNAVAILABLE'
    );
}

/**
 * Forwards a Renderer request to the Server, acting as the window that sent it when the method is window-scoped.
 */
export function forwardAsRequestWindow(
    connection: Pick<DesktopServerConnection, 'forward'>,
    method: CaxriMethod,
    parameters: unknown,
    requestId: string,
): Promise<unknown> {
    return connection.forward(
        method,
        withWindowKey(method, parameters, currentRequestWindowKey()),
        requestId,
    );
}

/**
 * The registry for the windows of one Server connection. The connection is read lazily because the registry is built
 * before the connection exists.
 */
export function createConnectionPresence(
    connection: () => Pick<DesktopServerConnection, 'request'>,
    logger: () => StructuredLogger | undefined,
): WindowPresenceRegistry {
    return new WindowPresenceRegistry({
        closePresence: (windowKey) => connection().request('window.closePresence', { windowKey }),
        onSendError: (error) =>
            logger()?.write('warn', logEventCatalog.window.presenceReportFailed, {
                fields: { error: errorMessage(error, 'unknown') },
            }),
        reportPresence: (report) => connection().request('window.reportPresence', report),
    });
}
