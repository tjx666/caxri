import { withTimeout } from '@caxri/utils';
import type { WebContents } from 'electron';

/**
 * Closed outcome of naming a hung Renderer's call stack. `debugger-busy` means another client already owns
 * `webContents.debugger`; `timeout` means the main thread never took the inspector interrupt, which points at native
 * work (layout, style, GC) rather than a JavaScript loop; `ended` means the hang was over before the pause landed, so
 * the stack would name unrelated code and is dropped.
 */
type RendererStackOutcome = 'captured' | 'debugger-busy' | 'ended' | 'failed' | 'timeout';

export interface RendererStackCapture {
    outcome: RendererStackOutcome;
    /**
     * Innermost frame first, `function@file:line:column` joined by `;`. Only bundle file names and function names,
     * never source text, arguments, or values.
     */
    stack?: string;
}

export interface RendererStackSampler {
    capture(): Promise<RendererStackCapture>;
    /**
     * Whether DevTools or an external CDP client (the remote-debugging port) holds the Renderer paused, which leaves
     * probes unanswered without the page being hung.
     */
    isPausedByAnotherClient(): boolean;
}

interface CallFrame {
    functionName: string;
    url: string;
    location: { lineNumber: number; columnNumber?: number };
}

export const MAX_STACK_FRAMES = 12;
const CAPTURE_TIMEOUT_MS = 3_000;

/**
 * Keeps `webContents.debugger` attached with the Debugger domain enabled for the window's lifetime, so a hang can be
 * paused once and named.
 *
 * The domain has to be enabled before the hang: only `Debugger.pause` interrupts running JavaScript, while
 * `Debugger.enable` waits for the thread to yield. Attaching and enabling at hang time never paused inside the loop;
 * the pause landed on the next statement after the hang ended and named the wrong code. With no breakpoints and no
 * async stack depth, an enabled debugger does not change how the page runs. Measured in a dev build (#3409), it adds
 * one `Debugger.scriptParsed` event per probe and no idle CPU above noise.
 *
 * Every pause this sampler requests is resumed when it lands, however late. A pause requested during native work takes
 * effect on the next JavaScript statement, possibly long after the capture timed out, and must never leave the window
 * stopped. Pauses requested by DevTools or another client are left alone, and no pause is requested while one holds the
 * Renderer: that request never lands as its own `Debugger.paused`, so the client's next pause would be taken for it and
 * resumed.
 */
export function createRendererStackSampler(webContents: WebContents): RendererStackSampler {
    const { debugger: inspector } = webContents;
    let isOwned = false;
    let isPauseRequested = false;
    let isPausedByAnotherClient = false;
    let waiter: ((frames: CallFrame[]) => void) | undefined;

    inspector.on('message', (_event, method, parameters) => {
        if (method === 'Debugger.resumed') isPausedByAnotherClient = false;
        if (method !== 'Debugger.paused') return;
        if (!isPauseRequested) {
            isPausedByAnotherClient = true;
            return;
        }
        isPauseRequested = false;
        void didSend('Debugger.resume');
        waiter?.((parameters as { callFrames: CallFrame[] }).callFrames);
        waiter = undefined;
    });
    inspector.on('detach', () => {
        isOwned = false;
        isPauseRequested = false;
        isPausedByAnotherClient = false;
    });
    /**
     * A crashed Renderer comes back as a new process whose debugger session starts over.
     */
    webContents.on('did-finish-load', ensureEnabled);
    ensureEnabled();

    /**
     * Resolves `false` instead of rejecting: a command fails only when the session is gone, which `detach` handles.
     */
    async function didSend(method: string): Promise<boolean> {
        try {
            await inspector.sendCommand(method);
            return true;
        } catch {
            return false;
        }
    }

    async function requestPause(): Promise<void> {
        if (!(await didSend('Debugger.pause'))) isPauseRequested = false;
    }

    function ensureEnabled(): void {
        isPausedByAnotherClient = false;
        if (webContents.isDestroyed()) return;
        if (!isOwned) {
            if (inspector.isAttached()) return;
            try {
                inspector.attach('1.3');
            } catch {
                return;
            }
            isOwned = true;
        }
        void didSend('Debugger.enable');
    }

    return {
        async capture() {
            if (!isOwned || isPausedByAnotherClient) return { outcome: 'debugger-busy' };
            const frames = Promise.withResolvers<CallFrame[]>();
            waiter = frames.resolve;
            isPauseRequested = true;
            /**
             * Not awaited: during native work the command itself is not answered until the thread yields.
             */
            void requestPause();
            const captured = await withTimeout(frames.promise, CAPTURE_TIMEOUT_MS);
            if (!captured) {
                waiter = undefined;
                return { outcome: 'timeout' };
            }
            return { outcome: 'captured', stack: formatRendererStack(captured) };
        },
        isPausedByAnotherClient: () => isPausedByAnotherClient,
    };
}

export function formatRendererStack(frames: readonly CallFrame[]): string {
    return frames
        .slice(0, MAX_STACK_FRAMES)
        .map((frame) => {
            const name = frame.functionName || '(anonymous)';
            const line = frame.location.lineNumber + 1;
            const column = (frame.location.columnNumber ?? 0) + 1;
            return `${name}@${scriptFileName(frame.url)}:${line}:${column}`;
        })
        .join(';');
}

/**
 * Keeps only the script's file name: a packaged URL carries the install path, which can include the account name.
 */
function scriptFileName(url: string): string {
    if (!url) return '-';
    const path = url.split(/[?#]/u, 1)[0] ?? '';
    return path.slice(path.lastIndexOf('/') + 1) || '-';
}
