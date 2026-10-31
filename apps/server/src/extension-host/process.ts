import process from 'node:process';

import {
    durableServerIdentitySchema,
    resolveLogLevel,
    serverBootIdentitySchema,
} from '@caxri/protocol';
import {
    installProcessErrorMonitor,
    logEventCatalog,
    mergeObservationContext,
    observationProcessManifestDirectory,
    ObservationProcessManifestPublisher,
    runWithObservationContext,
    startEventLoopMonitor,
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
    notifyLanguageChanged,
    notifyProjectStatusChanged,
    settleApiReply,
} from './api-factory';
import { setAppLanguage } from './app-language';
import { extensionErrorShape, extensionRequestFailureRecord } from './extension-error';
import { installExtensionModuleHooks, replaceExtensionModuleRegistrations } from './module-loader';
import { createExtensionHostProcessLifecycle } from './process-lifecycle';
import type {
    ExtensionHostMessage,
    ExtensionHostParentMessage,
    ExtensionHostRequest,
} from './protocol';
import { extensionHostParentMessageSchema } from './protocol';
import { logProtocolRejection } from './protocol-diagnostics';
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
    resolveLogLevel(process.env),
    { bootId, buildId, serverId },
);
const processManifest = new ObservationProcessManifestPublisher({
    context: { bootId, buildId, serverId },
    directory: observationProcessManifestDirectory(userDataPath),
    owner: 'extension-host',
});
processManifest.publish('starting');
/**
 * Server Core and Desktop Main already watch their loops; without this, a block here surfaced only as a slow request in
 * another process's log, with no record of which process stalled.
 */
const eventLoopMonitor = startEventLoopMonitor(logger);
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
    flushManifest: () => processManifest.flush(),
    publish: (state) => processManifest.publish(state),
    schedule: setImmediate,
    stopSampler: () => {
        eventLoopMonitor.stop();
        processSampler.stop();
    },
});

function send(message: ExtensionHostMessage): void {
    if (process.connected) process.send?.(message);
}

async function handle(request: ExtensionHostRequest): Promise<unknown> {
    switch (request.method) {
        case 'configure':
            replaceExtensionModuleRegistrations(request.params.extensions);
            setAppLanguage(request.params.locale);
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
        case 'languageChanged':
            return notifyLanguageChanged(request.params.locale);
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
        logProtocolRejection(logger, 'parent-envelope');
        void processLifecycle.stopAfterProtocolViolation();
        return;
    }
    const message: ExtensionHostParentMessage = parsed.data;
    if (isApiReply(message)) {
        settleApiReply(message);
        return;
    }
    const request = message;
    void processRequest(request);
});
process.once('disconnect', () => {
    void processLifecycle.stopAfterParentDisconnect();
});

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
                logger.recordMetric('extension_host.request', 1, {
                    owner: 'extension-host',
                    phase: 'execute',
                    outcome: 'success',
                });
                send({ type: 'reply', id: request.id, ok: true, result });
            } catch (error) {
                const shape = extensionErrorShape(error);
                const record = extensionRequestFailureRecord(shape.code, error);
                logger.recordMetric('extension_host.request', 1, {
                    owner: 'extension-host',
                    phase: 'execute',
                    outcome: record.outcome,
                });
                if (record.writeToLog)
                    logger.write(record.level, logEventCatalog.extensionHost.error, {
                        correlationId: request.id,
                        fields: { method: request.method, code: shape.code },
                        failure: record.failure,
                    });
                send({ type: 'reply', id: request.id, ok: false, error: shape });
            }
        },
    );
}

logger.write('info', logEventCatalog.extensionHost.ready, { fields: { pid: process.pid } });
processManifest.publish('ready');
send({ type: 'ready' });
