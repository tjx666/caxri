import { flushCompileCache } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    isCaxriError,
    logEventCatalog,
    REMOTE_PROFILE_IN_USE_MARKER,
    resolveLogLevel,
    SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY,
    serverDesktopLaunchSchema,
} from '@caxri/protocol';
import {
    computeBuildFingerprint,
    installProcessErrorMonitor,
    observationProcessManifestDirectory,
    ObservationProcessManifestPublisher,
    startProcessObservationSampler,
    StructuredLogger,
} from '@caxri/system';

import { writeCliLauncher } from './cli-launcher';
import { createDesktopLauncher } from './desktop-launcher';
import { extensionRootsForServer } from './extensions/discovery';
import { resolveIdleExitThresholdMs } from './idle-exit';
import { mobileUpdateDirectoryForServer } from './mobile/update-bundle';
import type { ServerCore, ServerCoreOptions } from './server-core';
import { startServerCore } from './server-core';

const userDataPath = process.env.CAXRI_USER_DATA_PATH;
if (!userDataPath) throw new Error('CAXRI_USER_DATA_PATH is required');

const version = typeof __CAXRI_VERSION__ === 'string' ? __CAXRI_VERSION__ : 'unknown';
const commit = typeof __CAXRI_COMMIT__ === 'string' ? __CAXRI_COMMIT__ : 'unknown';
process.env.CAXRI_APP_VERSION = version;
process.env.CAXRI_GIT_COMMIT = commit;
const logger = new StructuredLogger(
    join(userDataPath, 'logs'),
    'server-core',
    resolveLogLevel(process.env),
);
const processErrorMonitor = installProcessErrorMonitor({ processName: 'server-core' });
processErrorMonitor.attach(logger);
const serverBundleDirectory = dirname(fileURLToPath(import.meta.url));
/**
 * Captured once at startup: this is the fingerprint of the code this Server Core is actually running. A later watch
 * rebuild changes the on-disk bundles but not this value, which is exactly what lets the Desktop detect staleness.
 */
const buildId = await computeBuildFingerprint(serverBundleDirectory);
logger.updateBaseContext({ buildId });
const processManifest = new ObservationProcessManifestPublisher({
    context: { buildId },
    directory: observationProcessManifestDirectory(userDataPath),
    owner: 'server-core',
});
processManifest.publish('starting');
const desktopLaunchSource = process.env[SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY];
const desktopLaunch = desktopLaunchSource
    ? serverDesktopLaunchSchema.parse(JSON.parse(desktopLaunchSource) as unknown)
    : serverBundleDirectory.includes('.asar') && process.resourcesPath
      ? {
            executable: process.execPath,
            args: [],
            cwd: dirname(process.execPath),
        }
      : undefined;
const cliPath = process.env.CAXRI_CLI_PATH;
if (cliPath) {
    try {
        // Read by the Agent Endpoint environment alongside `CAXRI_CLI_PATH`.
        process.env.CAXRI_CLI = await writeCliLauncher({
            cliPath,
            executable: process.execPath,
            userDataPath,
        });
    } catch (error) {
        logger.write('error', logEventCatalog.serverCore.cliLauncherFailed, {
            fields: { message: error instanceof Error ? error.message : String(error) },
        });
    }
}

const serverCoreOptions: ServerCoreOptions = {
    agentHooksPath: process.env.CAXRI_AGENT_HOOKS_PATH,
    buildId,
    commit,
    cliPath,
    executable: process.execPath,
    extensionHostPath: join(serverBundleDirectory, 'extension-host.js'),
    terminalHostPath: join(serverBundleDirectory, 'terminal-host.js'),
    extensionRoots: extensionRootsForServer({
        serverBundleDirectory,
        userDataPath,
        ...(serverBundleDirectory.includes('.asar') &&
            process.resourcesPath && { resourcesPath: process.resourcesPath }),
    }),
    idleExitThresholdMs: resolveIdleExitThresholdMs(process.env),
    includeTestExtensions: process.env.CAXRI_E2E === '1',
    ...(process.env.CAXRI_E2E === '1' && {
        mobileHostDisplayName: process.env.CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME,
    }),
    logger,
    mobileUpdateDirectory: mobileUpdateDirectoryForServer({
        environment: process.env,
        serverBundleDirectory,
    }),
    projectSearch: {
        executablePath: join(serverBundleDirectory, '../runtime/bin/rg'),
        workerPath: join(serverBundleDirectory, 'project-search-worker.js'),
    },
    ...(desktopLaunch && {
        launchDesktop: createDesktopLauncher({
            launch: desktopLaunch,
            userDataPath,
        }),
    }),
    userDataPath,
    version,
};
let app: ServerCore;
try {
    app = await startServerCore(serverCoreOptions);
} catch (error) {
    // One machine-readable line for the SSH Host launch script; the rejection still prints its usual stack below.
    if (isCaxriError(error) && error.details?.reason === 'profileInUse')
        process.stderr.write(
            `${REMOTE_PROFILE_IN_USE_MARKER} host=${String(error.details.hostname)}\n`,
        );
    throw error;
}
const processContext = {
    bootId: app.lease.identity.processIdentity,
    buildId,
    serverId: app.protocolIdentity.serverId,
};
logger.updateBaseContext(processContext);
processManifest.publish('ready', { context: processContext });
/**
 * Persists the compile cache `bootstrap.ts` enabled (a no-op when it did not). Node otherwise writes it only on a
 * normal exit, and this module's top-level await does not settle until shutdown.
 */
flushCompileCache();
/**
 * The first resource sample reads process state immediately. Start it only after Core readiness so diagnostics cannot
 * contend with Project watcher installation on the startup critical path.
 */
const processSampler = startProcessObservationSampler({
    logger,
    owner: 'server-core',
    publisher: processManifest,
});

{
    let finalizationPromise: Promise<void> | undefined;
    let isSignalReceived = false;
    const finalizeProcess = (): Promise<void> => {
        finalizationPromise ??= (async () => {
            processSampler.stop();
            processManifest.publish('stopped');
            /**
             * `process.exit()` does not wait for pending filesystem work. Persist the terminal lifecycle state before
             * exiting so offline diagnostics can distinguish an intentional shutdown from a crashed ready process.
             */
            await processManifest.flush();
            // This file is the Server Core process entrypoint supervised by a client or platform;
            // an explicit exit after graceful async shutdown is the correct terminal action here.
            // eslint-disable-next-line unicorn/no-process-exit -- Server Core process entrypoint, not a library
            process.exit(0);
        })();
        return finalizationPromise;
    };
    const stopForSignal = async (signal: NodeJS.Signals): Promise<void> => {
        if (isSignalReceived) return;
        isSignalReceived = true;
        try {
            await app.stop(signal);
        } finally {
            await finalizeProcess();
        }
    };
    /**
     * Server Core is a daemon that must outlive whatever started it. A Server launched from an SSH login on an SSH Host
     * would otherwise die on the default SIGHUP action when that login ends, taking every Terminal and Agent with it.
     * Launchers already detach into a new session; ignoring the hangup covers any path that does not.
     */
    process.on('SIGHUP', () => {});
    process.once('SIGINT', async (signal) => {
        try {
            await stopForSignal(signal);
        } catch {
            // stopForSignal already exits the process on success; a rejection here means
            // shutdown itself failed, which is not actionable from a signal handler.
        }
    });
    process.once('SIGTERM', async (signal) => {
        try {
            await stopForSignal(signal);
        } catch {
            // stopForSignal already exits the process on success; a rejection here means
            // shutdown itself failed, which is not actionable from a signal handler.
        }
    });
    /**
     * Both signal-driven and protocol-driven stops must expose the same offline lifecycle.
     */
    await app.stopping;
    processSampler.stop();
    processManifest.publish('stopping');
    await app.stopped;
    await finalizeProcess();
}
