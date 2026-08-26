import process from 'node:process';

import {
    activateExtension,
    cancelTreeRequest,
    configureExtensions,
    disposeAllExtensions,
    executeExtensionCommand,
    extensionApiBinding,
    getTreeChildren,
    notifyActiveContextChanged,
    notifyGitChanged,
    notifyProjectStatusChanged,
    settleApiReply,
} from './api-factory';
import { extensionErrorShape } from './extension-error';
import { installExtensionModuleHooks, replaceExtensionModuleRegistrations } from './module-loader';
import type {
    ExtensionHostMessage,
    ExtensionHostParentMessage,
    ExtensionHostRequest,
} from './protocol';
import { executeViewOperation } from './view-provider-service';

function isApiReply(
    message: unknown,
): message is Extract<ExtensionHostParentMessage, { type: 'api-reply' }> {
    return (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'api-reply'
    );
}

if (!process.connected || !process.send)
    throw new Error('CAXRI_EXTENSION_HOST_IPC_REQUIRED: Extension Host must be forked by Host');

function send(message: ExtensionHostMessage): void {
    if (process.connected) process.send?.(message);
}

async function handle(request: ExtensionHostRequest): Promise<unknown> {
    switch (request.method) {
        case 'configure':
            replaceExtensionModuleRegistrations(request.params.extensions);
            configureExtensions(request.params.extensions);
            return { configured: request.params.extensions.length };
        case 'activate':
            await activateExtension(request.params.extensionId, request.params.generation);
            return { activated: true };
        case 'treeChildren':
            return getTreeChildren(request.params);
        case 'executeCommand':
            return executeExtensionCommand(request.params);
        case 'viewOperation':
            await activateExtension(request.params.extensionId, request.params.generation);
            return executeViewOperation(request.params);
        case 'activeContextChanged':
            return notifyActiveContextChanged(request.params.context);
        case 'gitChanged':
            return notifyGitChanged(request.params.context);
        case 'projectStatusChanged':
            return notifyProjectStatusChanged(request.params.context);
        case 'cancel':
            return cancelTreeRequest(request.params.requestId);
        case 'shutdown':
            disposeAllExtensions();
            setImmediate(() => {
                // eslint-disable-next-line unicorn/no-process-exit -- The Extension Host must exit after completing the shutdown request.
                process.exit(0);
            });
            return { stopped: true };
    }
}

installExtensionModuleHooks();
Object.defineProperty(globalThis, Symbol.for('caxri.extension-api'), {
    configurable: false,
    enumerable: false,
    value: extensionApiBinding,
    writable: false,
});

process.on('message', (message: ExtensionHostParentMessage) => {
    if (isApiReply(message)) {
        settleApiReply(message);
        return;
    }
    const request = message;
    // eslint-disable-next-line no-void -- Message handling is intentionally fire-and-forget; processRequest catches and replies.
    void processRequest(request);
});

async function processRequest(request: ExtensionHostRequest): Promise<void> {
    try {
        const result = await handle(request);
        send({ type: 'reply', id: request.id, ok: true, result });
    } catch (error) {
        send({ type: 'reply', id: request.id, ok: false, error: extensionErrorShape(error) });
    }
}

send({ type: 'ready' });
