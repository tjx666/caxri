import process from 'node:process';

import { durableServerIdentitySchema, serverBootIdentitySchema } from '@caxri/protocol';
import {
    installProcessErrorMonitor,
    logEventCatalog,
    mergeObservationContext,
    observationProcessManifestDirectory,
    ObservationProcessManifestPublisher,
    runWithObservationContext,
    startProcessObservationSampler,
    StructuredLogger,
} from '@caxri/system';

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
import { createExtensionHostProcessLifecycle } from './process-lifecycle';
import type {
    ExtensionHostMessage,
    ExtensionHostParentMessage,
    ExtensionHostRequest,
} from './protocol';
import { extensionHostParentMessageSchema } from './protocol';
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
    throw new Error(
        'CAXRI_EXTENSION_HOST_IPC_REQUIRED: Extension Host must be forked by Server Core',
    );

function requiredEnvironment(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

const bootId = serverBootIdentitySchema.parse(requiredEnvironment('CAXRI_SERVER_BOOT_ID'));
const buildId = requiredEnvironment('CAXRI_BUILD_ID');
const serverId = durableServerIdentitySchema.parse(requiredEnvironment('CAXRI_SERVER_ID'));
const userDataPath = requiredEnvironment('CAXRI_USER_DATA_PATH');
const logger = new StructuredLogger(
    requiredEnvironment('CAXRI_LOG_DIRECTORY'),
    'extension-host',
    'info',
    { bootId, buildId, serverId },
);
const processManifest = new ObservationProcessManifestPublisher({
    context: { bootId, buildId, serverId },
    directory: observationProcessManifestDirectory(userDataPath),
    owner: 'extension-host',
});
processManifest.publish('starting');
const processSampler = startProcessObservationSampler({
    logger,
    owner: 'extension-host',
    publisher: processManifest,
});
const processErrorMonitor = installProcessErrorMonitor({ processName: 'extension-host' });
processErrorMonitor.attach(logger);
const processLifecycle = createExtensionHostProcessLifecycle({
    disposeExtensions: disposeAllExtensions,
    exit: (exitCode) => {
        // eslint-disable-next-line unicorn/no-process-exit -- The owned Extension Host must exit after shutdown or parent loss.
        process.exit(exitCode);
    },
    publish: (state) => processManifest.publish(state),
    schedule: setImmediate,
    stopSampler: () => processSampler.stop(),
});

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
            processLifecycle.scheduleRequestedShutdown();
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

process.on('message', (value: unknown) => {
    const parsed = extensionHostParentMessageSchema.safeParse(value);
    if (!parsed.success) {
        logger.write('error', logEventCatalog.extensionHost.invalidMessage);
        processLifecycle.stopAfterProtocolViolation();
        return;
    }
    const message: ExtensionHostParentMessage = parsed.data;
    if (isApiReply(message)) {
        settleApiReply(message);
        return;
    }
    const request = message;
    // eslint-disable-next-line no-void -- Message handling is intentionally fire-and-forget; processRequest catches and replies.
    void processRequest(request);
});
process.once('disconnect', () => processLifecycle.stopAfterParentDisconnect());

async function processRequest(request: ExtensionHostRequest): Promise<void> {
    await runWithObservationContext(
        mergeObservationContext(request.observation, {
            operationId: request.id,
            requestId: request.observation?.requestId ?? request.id,
            traceId: request.observation?.traceId ?? request.id,
        }),
        async () => {
            try {
                const result = await handle(request);
                send({ type: 'reply', id: request.id, ok: true, result });
            } catch (error) {
                const failure = extensionErrorShape(error);
                logger.write('warn', logEventCatalog.extensionHost.error, {
                    correlationId: request.id,
                    fields: { method: request.method, code: failure.code },
                    failure: {
                        code: failure.code,
                        owner: 'extension-host',
                        phase: 'execute',
                        reason: 'unknown',
                        remediation: 'restart-extension-host',
                        retryable: false,
                    },
                });
                send({ type: 'reply', id: request.id, ok: false, error: failure });
            }
        },
    );
}

logger.write('info', logEventCatalog.extensionHost.ready, { fields: { pid: process.pid } });
processManifest.publish('ready');
send({ type: 'ready' });
