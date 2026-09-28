import { createRecoveringEventClient } from '@caxri/client/state';
import type {
    CaxriBridge,
    CaxriMethod,
    MethodReply,
    ParametersArgument,
    ProtocolEventEnvelope,
    ProtocolWelcome,
    ServerEvent,
    TransientServerEvent,
} from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION, fromWireError } from '@caxri/protocol';
import { notifyListeners } from '@caxri/utils';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * Kept entry-local because sharing this constant across both preload entries makes Vite extract a CommonJS chunk, which
 * Electron's sandboxed preload loader cannot require.
 */
const rendererErrorChannel = 'caxri:renderer-error';
/**
 * Kept entry-local for the same sandboxed-preload chunking reason as `rendererErrorChannel`; the browser-safe protocol
 * owns the matching payload schema and Main validates every report before logging it.
 */
const rendererDiagnosticChannel = 'caxri:renderer-diagnostic';
/**
 * Electron's sandbox exposes its limited `process` global but cannot load `node:process`; importing that module makes
 * the entire CommonJS preload fail before the bridge is installed.
 */
// eslint-disable-next-line n/prefer-global/process -- required by Electron's sandboxed preload runtime
const isE2E = process.env.CAXRI_E2E === '1';
/**
 * Set only by `switch-worktree dev` (see `.agents/skills/switch-worktree/scripts/worktree.ts`), never by a packaged
 * install or a bare `bun run dev`. Exposed below as `globalThis.__caxriWorktree` so a CDP connection can verify it
 * reached this worktree's window instead of a sibling worktree's sharing the same `Electron/...` user agent.
 *
 * @see https://github.com/tjx666/caxri/issues/1016
 */
// eslint-disable-next-line n/prefer-global/process -- required by Electron's sandboxed preload runtime
const worktreePath = process.env.CAXRI_WORKTREE_PATH;
interface E2ERequestGate {
    markReached: () => void;
    reached: Promise<void>;
    release: () => void;
    released: Promise<void>;
}

interface E2EMobilePairingBridge {
    created: Promise<string>;
    deliver: (pairingLink: string) => void;
}

const e2eRequestState: {
    logsQueryCount: number;
    logsQueryTimestamps: number[];
    mobilePairingBridge?: E2EMobilePairingBridge;
    pathBrowserStartGate?: E2ERequestGate;
    settingsLoadGate?: E2ERequestGate;
    sessionStateUpdateCount: number;
} = { logsQueryCount: 0, logsQueryTimestamps: [], sessionStateUpdateCount: 0 };

function createE2ERequestGate(): E2ERequestGate {
    const { promise: reached, resolve: markReached } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    return { markReached, reached, release, released };
}

function createE2EMobilePairingBridge(): E2EMobilePairingBridge {
    const { promise: created, resolve: deliver } = Promise.withResolvers<string>();
    return { created, deliver };
}

/**
 * Forwards a structured request and hands the reply envelope back untouched. Main answers with `{ id, ok, result |
 * error }` rather than throwing so the Caxri error code survives both the Electron IPC hop and the `contextBridge`
 * copy, which reduces a thrown error to its message and stack.
 */
async function requestWithId<M extends CaxriMethod>(
    requestId: string,
    method: M,
    ...arguments_: ParametersArgument<M>
): Promise<MethodReply<M>> {
    if (isE2E && method === 'logs.query') {
        e2eRequestState.logsQueryCount += 1;
        e2eRequestState.logsQueryTimestamps.push(Date.now());
        if (e2eRequestState.logsQueryTimestamps.length > 32)
            e2eRequestState.logsQueryTimestamps.shift();
    }
    if (isE2E && method === 'session.updateState') e2eRequestState.sessionStateUpdateCount += 1;
    if (isE2E && method === 'pathBrowser.start' && e2eRequestState.pathBrowserStartGate) {
        const gate = e2eRequestState.pathBrowserStartGate;
        gate.markReached();
        await gate.released;
    }
    if (isE2E && method === 'theme.get' && e2eRequestState.settingsLoadGate) {
        const gate = e2eRequestState.settingsLoadGate;
        gate.markReached();
        await gate.released;
    }
    /**
     * The payload crosses a process boundary as unknown; the method table owns its static shape.
     */
    const reply = (await ipcRenderer.invoke('caxri:request', {
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id: requestId,
        method,
        params: arguments_[0] ?? {},
    })) as MethodReply<M>;
    if (isE2E && method === 'mobile.pairing.create' && reply.ok) {
        const pairingLink: unknown = Reflect.get(reply.result as object, 'pairingLink');
        if (typeof pairingLink === 'string')
            e2eRequestState.mobilePairingBridge?.deliver(pairingLink);
    }
    return reply;
}

async function request<M extends CaxriMethod>(
    method: M,
    ...arguments_: ParametersArgument<M>
): Promise<MethodReply<M>> {
    return requestWithId(crypto.randomUUID(), method, ...arguments_);
}

const eventListeners = new Set<(event: ServerEvent) => void>();
const eventClient = createRecoveringEventClient({
    /**
     * `notifyListeners` isolates each listener so one throwing subscriber cannot stop delivery to the rest, and cannot
     * make the event unrecoverable: this recovering client's cursor has already advanced past `event` by the time
     * `emit` runs, so a bubbled exception here would both skip the remaining listeners and permanently drop the event
     * instead of ever replaying it.
     */
    emit: (event) => {
        notifyListeners(eventListeners, event, (error) => {
            // Diagnostics must never include the event payload (it may carry Terminal output or
            // Agent transcripts); report only the event's type and the error.
            console.error(`[caxri] Server event listener threw for "${event.event}"`, error);
        });
    },
    recover: async (afterCursor) => {
        const reply = await request('events.recover', { afterCursor });
        if (!reply.ok) throw fromWireError(reply.error);
        return reply.result;
    },
});
const eventHandler = (
    _event: Electron.IpcRendererEvent,
    message: ProtocolEventEnvelope | TransientServerEvent,
): void => eventClient.receive(message);

const bridge: CaxriBridge = {
    negotiate: async () =>
        (await ipcRenderer.invoke('caxri:negotiate', {
            supportedVersions: [CAXRI_PROTOCOL_VERSION],
        })) as ProtocolWelcome,
    request,
    requestWithId,
    reportDiagnostic: (diagnostic) => ipcRenderer.send(rendererDiagnosticChannel, diagnostic),
    reportError: (kind) => ipcRenderer.send(rendererErrorChannel, kind),
    pathForFile: (file) => webUtils.getPathForFile(file),
    onEvent: (listener: (event: ServerEvent) => void): (() => void) => {
        eventListeners.add(listener);
        if (eventListeners.size === 1) {
            ipcRenderer.on('caxri:event', eventHandler);
            ipcRenderer.send('caxri:renderer-events-ready');
            // `onEvent` must return its unsubscribe function synchronously, so starting the
            // recovery client here is deliberately fire-and-forget rather than awaited.
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            eventClient.start().catch(() => {});
        }
        return () => {
            eventListeners.delete(listener);
            if (eventListeners.size === 0) {
                ipcRenderer.removeListener('caxri:event', eventHandler);
                eventClient.stop();
            }
        };
    },
};

contextBridge.exposeInMainWorld('caxri', bridge);

if (worktreePath) contextBridge.exposeInMainWorld('__caxriWorktree', worktreePath);

if (isE2E) {
    /**
     * These narrow E2E-only seams expose synchronization for focused regressions. The mobile pairing bridge transfers
     * one link exactly once while Acceptance capture is disabled so the QR credential never enters an artifact; it
     * neither records arbitrary requests nor persists the link. Production builds do not expose these seams.
     */
    contextBridge.exposeInMainWorld('caxriE2E', {
        armMobilePairingBridge: () => {
            e2eRequestState.mobilePairingBridge = createE2EMobilePairingBridge();
        },
        armPathBrowserStartGate: () => {
            e2eRequestState.pathBrowserStartGate = createE2ERequestGate();
        },
        armSettingsLoadGate: () => {
            e2eRequestState.settingsLoadGate = createE2ERequestGate();
        },
        releaseSettingsLoadGate: () => {
            e2eRequestState.settingsLoadGate?.release();
            e2eRequestState.settingsLoadGate = undefined;
        },
        waitForSettingsLoadGate: () => e2eRequestState.settingsLoadGate?.reached,
        releasePathBrowserStartGate: () => {
            e2eRequestState.pathBrowserStartGate?.release();
            e2eRequestState.pathBrowserStartGate = undefined;
        },
        resetLogsQueryCount: () => {
            e2eRequestState.logsQueryCount = 0;
            e2eRequestState.logsQueryTimestamps = [];
        },
        resetSessionStateUpdateCount: () => {
            e2eRequestState.sessionStateUpdateCount = 0;
        },
        logsQueryCount: () => e2eRequestState.logsQueryCount,
        logsQueryTimestamps: () => [...e2eRequestState.logsQueryTimestamps],
        /**
         * Forwarded verbatim; `renderer/src/lib/poll-scheduler.ts` owns parsing and bounding it, so this entry stays
         * free of the shared module that Electron's sandboxed preload loader cannot require.
         */
        // eslint-disable-next-line n/prefer-global/process -- required by Electron's sandboxed preload runtime
        maxPollIntervalMs: process.env.CAXRI_E2E_MAX_POLL_INTERVAL_MS,
        sessionStateUpdateCount: () => e2eRequestState.sessionStateUpdateCount,
        takeMobilePairingLink: async () => {
            const bridge = e2eRequestState.mobilePairingBridge;
            if (!bridge) throw new Error('Mobile pairing bridge is not armed');
            try {
                return await bridge.created;
            } finally {
                e2eRequestState.mobilePairingBridge = undefined;
            }
        },
        waitForPathBrowserStartGate: () => e2eRequestState.pathBrowserStartGate?.reached,
    });
}
