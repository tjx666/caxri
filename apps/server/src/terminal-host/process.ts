import { join } from 'node:path';
import process from 'node:process';

import {
    resolveLogLevel,
    serverCredentialTokenSchema,
    serverProcessIdentitySchema,
} from '@caxri/protocol';
import {
    defaultUnixSocketDirectory,
    installProcessErrorMonitor,
    logEventCatalog,
    observationProcessManifestDirectory,
    ObservationProcessManifestPublisher,
    startEventLoopMonitor,
    startProcessObservationSampler,
    StructuredLogger,
} from '@caxri/system';
import * as pty from 'node-pty';

import { ManagedAgentLauncherServer } from './agent-launcher';
import { managedAgentLauncherSocketPath } from './agent-launcher/socket-path';
import { resolveE2ETerminalOutputFlushDelay } from './e2e-options';
import type { TerminalHostMessage } from './protocol';
import { TerminalHostRuntime } from './runtime';
import { installTerminationSignalHandlers } from './termination-signal';

if (!process.connected || !process.send)
    throw new Error(
        'CAXRI_TERMINAL_HOST_IPC_REQUIRED: Terminal Host must be forked by Server Core',
    );

function requiredEnvironment(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

const userDataPath = requiredEnvironment('CAXRI_USER_DATA_PATH');
const appVersion = requiredEnvironment('CAXRI_APP_VERSION');
const buildId = requiredEnvironment('CAXRI_BUILD_ID');
const commit = requiredEnvironment('CAXRI_GIT_COMMIT');
const credential = serverCredentialTokenSchema.parse(
    requiredEnvironment('CAXRI_TERMINAL_HOST_CREDENTIAL'),
);
const bootId = serverProcessIdentitySchema.parse(requiredEnvironment('CAXRI_SERVER_BOOT_ID'));
const logger = new StructuredLogger(
    join(userDataPath, 'logs'),
    'terminal-host',
    resolveLogLevel(process.env),
    { bootId, buildId },
);
const processManifest = new ObservationProcessManifestPublisher({
    context: { bootId, buildId },
    directory: observationProcessManifestDirectory(userDataPath),
    owner: 'terminal-host',
});
processManifest.publish('starting');
/**
 * Server Core and Desktop Main already watch their loops; without this, a block here surfaced only as a slow request in
 * another process's log, with no record of which process stalled.
 */
const eventLoopMonitor = startEventLoopMonitor(logger);
const processSampler = startProcessObservationSampler({
    logger,
    owner: 'terminal-host',
    publisher: processManifest,
});
const processErrorMonitor = installProcessErrorMonitor({ processName: 'terminal-host' });
processErrorMonitor.attach(logger);

const lifecycle = { isStopping: false };
const send = (message: TerminalHostMessage): void => {
    if (process.connected) process.send?.(message);
};
const runtimeReference: { current?: TerminalHostRuntime } = {};
const agentLauncher = new ManagedAgentLauncherServer({
    socketPath: managedAgentLauncherSocketPath(defaultUnixSocketDirectory(), bootId),
    runtimePath: process.execPath,
    entryPath: join(import.meta.dirname, 'agent-launcher.js'),
    onEvent: (event) => {
        const currentRuntime = runtimeReference.current;
        if (!currentRuntime) throw new Error('Terminal Host Runtime is not initialized');
        currentRuntime.projectManagedAgentEvent(event);
    },
    beforeExitAck: (terminalId) => runtimeReference.current!.quiesceManagedAgentInput(terminalId),
});
await agentLauncher.start();
const runtime = new TerminalHostRuntime({
    agentLauncher,
    appVersion,
    bootId,
    buildId,
    commit,
    credential,
    logger,
    outputFlushMs: resolveE2ETerminalOutputFlushDelay(process.env),
    onProtocolViolation: () => {
        logger.write('error', logEventCatalog.terminalHost.invalidMessage);
        if (lifecycle.isStopping) return;
        lifecycle.isStopping = true;
        setImmediate(() => {
            // eslint-disable-next-line unicorn/no-process-exit -- A malformed private IPC frame invalidates the child.
            process.exit(1);
        });
    },
    send,
    spawn: pty.spawn,
});
runtimeReference.current = runtime;

async function stop(exitCode: number): Promise<void> {
    if (lifecycle.isStopping) return;
    lifecycle.isStopping = true;
    eventLoopMonitor.stop();
    processSampler.stop();
    processManifest.publish('stopping');
    try {
        await runtime.stopAfterParentDisconnect();
        logger.write('info', logEventCatalog.terminalHost.stopped, { fields: { exitCode } });
        await logger.flush();
        processManifest.publish('stopped');
        /**
         * `process.exit()` does not wait for pending filesystem work. Persist the terminal lifecycle state before
         * exiting so offline diagnostics can distinguish an intentional shutdown from a crashed ready process.
         */
        await processManifest.flush();
    } finally {
        // eslint-disable-next-line unicorn/no-process-exit -- This is the owned Terminal Host process entrypoint.
        process.exit(exitCode);
    }
}

process.on('message', (message: unknown) => {
    void runtime.accept(message);
});

process.once('disconnect', () => {
    void stop(0);
});
installTerminationSignalHandlers({
    target: process,
    isConnected: () => process.connected,
    waitForShutdownRequest: (timeoutMs) => runtime.waitForShutdownRequest(timeoutMs),
    stop,
});

logger.write('info', logEventCatalog.terminalHost.ready, {
    fields: { bootId, buildId, pid: process.pid },
});
processManifest.publish('ready');
runtime.ready();
