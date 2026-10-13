import type { CaxriMethod, ParametersArgument } from '@caxri/protocol';
import { createCaxriClient } from '@caxri/protocol';

import { showConfirm, showConfirmChoice } from '../stores/confirmations';

/**
 * Renderer-owned UI namespace, deliberately shaped like VS Code's `vscode.window`: a feature asks the user a question
 * through one shared implementation instead of mounting its own dialog, so appearance, keyboard behavior, and the
 * meaning of a dismissal stay identical everywhere. It is grouped onto the same `caxri` object as the IPC forwarders so
 * call sites read as one API surface (`caxri.request(...)` beside `caxri.window.showConfirm(...)`); the implementation
 * itself stays in `stores/confirmations.ts` and never touches the transport.
 */
const windowNamespace = { showConfirm, showConfirmChoice };

/**
 * Single Renderer entry point for IPC. The preload bridge resolves with reply envelopes because `contextBridge` strips
 * the prototype and own properties from a thrown error; this client unwraps them and rejects with a real `CaxriError`,
 * so callers can branch on `error.code`.
 *
 * `window.caxri` is read lazily inside the forwarders so importing this module never depends on the preload having run,
 * which keeps Renderer unit tests importable without an Electron window.
 */
const client = createCaxriClient({
    negotiate: () => globalThis.caxri.negotiate(),
    request: <M extends CaxriMethod>(method: M, ...arguments_: ParametersArgument<M>) =>
        globalThis.caxri.request(method, ...arguments_),
    requestWithId: <M extends CaxriMethod>(
        requestId: string,
        method: M,
        ...arguments_: ParametersArgument<M>
    ) => globalThis.caxri.requestWithId(requestId, method, ...arguments_),
    onEvent: (listener) => globalThis.caxri.onEvent(listener),
});

export const caxri = { ...client, window: windowNamespace };
