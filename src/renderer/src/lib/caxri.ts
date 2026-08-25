import type { CaxriMethod, ParamsArg } from '@shared/ipc';
import { createCaxriClient } from '@shared/ipc';

/**
 * Single Renderer entry point for IPC. The preload bridge resolves with reply envelopes because `contextBridge` strips
 * the prototype and own properties from a thrown error; this client unwraps them and rejects with a real `CaxriError`,
 * so callers can branch on `error.code`.
 *
 * `window.caxri` is read lazily inside the forwarders so importing this module never depends on the preload having run,
 * which keeps Renderer unit tests importable without an Electron window.
 */
export const caxri = createCaxriClient({
    negotiate: () => globalThis.caxri.negotiate(),
    request: <M extends CaxriMethod>(method: M, ...arguments_: ParamsArg<M>) =>
        globalThis.caxri.request(method, ...arguments_),
    requestWithId: <M extends CaxriMethod>(
        requestId: string,
        method: M,
        ...arguments_: ParamsArg<M>
    ) => globalThis.caxri.requestWithId(requestId, method, ...arguments_),
    onEvent: (listener) => globalThis.caxri.onEvent(listener),
});
