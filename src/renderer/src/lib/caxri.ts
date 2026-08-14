import { createCaxriClient, type CaxriMethod, type ParamsArg } from '@shared/ipc';

/**
 * Single Renderer entry point for IPC. The preload bridge resolves with reply envelopes because
 * `contextBridge` strips the prototype and own properties from a thrown error; this client unwraps
 * them and rejects with a real `CaxriError`, so callers can branch on `error.code`.
 *
 * `window.caxri` is read lazily inside the forwarders so importing this module never depends on the
 * preload having run, which keeps Renderer unit tests importable without an Electron window.
 */
export const caxri = createCaxriClient({
    negotiate: () => window.caxri.negotiate(),
    request: <M extends CaxriMethod>(method: M, ...args: ParamsArg<M>) =>
        window.caxri.request(method, ...args),
    onEvent: (listener) => window.caxri.onEvent(listener),
});
