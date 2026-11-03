import type {
    CaxriClient,
    CaxriMethod,
    MethodReply,
    ParametersArgument,
    ServerEvent,
} from '@caxri/protocol';
import { createCaxriClient } from '@caxri/protocol';

import { showConfirm, showConfirmChoice } from '../stores/confirmations';
import {
    indexReplyRecords,
    resolveRequestEnvironment,
    trackRemoteRequest,
} from './environment-routing';

/**
 * Renderer-owned UI namespace, deliberately shaped like VS Code's `vscode.window`: a feature asks the user a question
 * through one shared implementation instead of mounting its own dialog, so appearance, keyboard behavior, and the
 * meaning of a dismissal stay identical everywhere. It is grouped onto the same `caxri` object as the IPC forwarders so
 * call sites read as one API surface (`caxri.request(...)` beside `caxri.window.showConfirm(...)`); the implementation
 * itself stays in `stores/confirmations.ts` and never touches the transport.
 */
const windowNamespace = { showConfirm, showConfirmChoice };

/**
 * Where a request goes: `auto` reads the Session, Terminal, or Project it names; `local` is this Mac's Server; any
 * other string is a connected SSH Host's id.
 */
type RequestTarget = 'auto' | 'local' | (string & {});

/**
 * @param target The machine the request goes to.
 * @param requestId The caller's id for a cancellable request, or `undefined` to let the bridge pick one.
 * @param method The method to call.
 * @param arguments_ The method's parameters, as `caxri.request` received them.
 */
async function send<M extends CaxriMethod>(
    target: RequestTarget,
    requestId: string | undefined,
    method: M,
    arguments_: ParametersArgument<M>,
): Promise<MethodReply<M>> {
    const environmentId =
        target === 'auto'
            ? resolveRequestEnvironment(method, arguments_[0])
            : target === 'local'
              ? undefined
              : target;
    const environments = globalThis.caxri.environments;
    if (environmentId === undefined || !environments)
        return requestId === undefined
            ? globalThis.caxri.request(method, ...arguments_)
            : globalThis.caxri.requestWithId(requestId, method, ...arguments_);
    const id = requestId ?? crypto.randomUUID();
    const untrack = trackRemoteRequest(id, environmentId);
    try {
        const reply = await environments.requestWithId(environmentId, id, method, ...arguments_);
        if (reply.ok) indexReplyRecords(environmentId, reply.result);
        return reply;
    } finally {
        untrack();
    }
}

/**
 * Events an SSH Host's Server or its Main-side route sends that describe this device rather than that Host: settings,
 * keybindings, and theme are this Mac's, and window, update, and menu events come from this Mac's Main. Dropping them
 * keeps a remote Host from repainting or reconfiguring the Workbench.
 */
const DEVICE_EVENT_PREFIXES = [
    'caxriBot.',
    'command.',
    'desktop.',
    'gpu.',
    'host.',
    'keybindings.',
    'notifications.',
    'runtime.',
    'settings.',
    'sshHost.',
    'theme.',
    'update',
    'window.',
];

function isDeviceEvent(event: ServerEvent): boolean {
    return DEVICE_EVENT_PREFIXES.some((prefix) => event.event.startsWith(prefix));
}

/**
 * A listener receives this Mac's events with no `environmentId`, and a connected SSH Host's events with its id.
 */
type EnvironmentEventListener = (event: ServerEvent, environmentId?: string) => void;

function onEvent(listener: EnvironmentEventListener): () => void {
    const unsubscribeLocal = globalThis.caxri.onEvent((event) => listener(event));
    const unsubscribeRemote = globalThis.caxri.environments?.onEvent((event, environmentId) => {
        if (!isDeviceEvent(event)) listener(event, environmentId);
    });
    return () => {
        unsubscribeLocal();
        unsubscribeRemote?.();
    };
}

function clientFor(target: RequestTarget): CaxriClient {
    return createCaxriClient({
        negotiate: () => globalThis.caxri.negotiate(),
        request: <M extends CaxriMethod>(method: M, ...arguments_: ParametersArgument<M>) =>
            send(target, undefined, method, arguments_),
        requestWithId: <M extends CaxriMethod>(
            requestId: string,
            method: M,
            ...arguments_: ParametersArgument<M>
        ) => send(target, requestId, method, arguments_),
        onEvent,
    });
}

/**
 * Single Renderer entry point for IPC. The preload bridge resolves with reply envelopes because `contextBridge` strips
 * the prototype and own properties from a thrown error; this client unwraps them and rejects with a real `CaxriError`,
 * so callers can branch on `error.code`.
 *
 * A request goes to the Server owning the Session, Terminal, or Project it names (see `environment-routing.ts`), so the
 * same call works for a Session on this Mac and one on an SSH Host. `caxri.in(environmentId)` names the target
 * outright, for requests that name no such record, like adding a Project or browsing a folder on a chosen machine.
 *
 * `window.caxri` is read lazily inside the forwarders so importing this module never depends on the preload having run,
 * which keeps Renderer unit tests importable without an Electron window.
 */
const client = clientFor('auto');

export const caxri = {
    ...client,
    onEvent,
    /**
     * A client for one machine: `undefined` is this Mac, any other value a connected SSH Host's id.
     */
    in: (environmentId: string | undefined) => clientFor(environmentId ?? 'local'),
    environments: {
        attach: (environmentId: string) => globalThis.caxri.environments?.attach(environmentId),
        detach: (environmentId: string) => globalThis.caxri.environments?.detach(environmentId),
    },
    window: windowNamespace,
};
