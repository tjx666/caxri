import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY, hostDesktopLaunchSchema } from '@caxri/protocol';
import {
    computeBuildFingerprint,
    installProcessErrorMonitor,
    StructuredLogger,
} from '@caxri/system';

import { startHostApp } from './app';
import { createDesktopLauncher } from './desktop-launcher';
import { extensionRootsForHost } from './extensions/discovery';

const userDataPath = process.env.CAXRI_USER_DATA_PATH;
if (!userDataPath) throw new Error('CAXRI_USER_DATA_PATH is required');

const version = typeof __CAXRI_VERSION__ === 'string' ? __CAXRI_VERSION__ : 'unknown';
const commit = typeof __CAXRI_COMMIT__ === 'string' ? __CAXRI_COMMIT__ : 'unknown';
process.env.CAXRI_APP_VERSION = version;
process.env.CAXRI_GIT_COMMIT = commit;
const logger = new StructuredLogger(join(userDataPath, 'logs'), 'host', 'info');
const processErrorMonitor = installProcessErrorMonitor({ processName: 'host' });
processErrorMonitor.attach(logger);
const serverBundleDirectory = dirname(fileURLToPath(import.meta.url));
/**
 * Captured once at startup: this is the fingerprint of the code this Server Core is actually running. A later watch
 * rebuild changes the on-disk bundles but not this value, which is exactly what lets the Desktop detect staleness.
 */
const buildId = await computeBuildFingerprint(serverBundleDirectory);
const desktopLaunchSource = process.env[HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY];
const desktopLaunch = desktopLaunchSource
    ? hostDesktopLaunchSchema.parse(JSON.parse(desktopLaunchSource) as unknown)
    : serverBundleDirectory.includes('.asar') && process.resourcesPath
      ? {
            executable: process.execPath,
            args: [],
            cwd: dirname(process.execPath),
        }
      : undefined;
const cliPath = process.env.CAXRI_CLI_PATH;

const app = await startHostApp({
    agentHooksPath: process.env.CAXRI_AGENT_HOOKS_PATH,
    buildId,
    commit,
    cliPath,
    executable: process.execPath,
    extensionHostPath: join(serverBundleDirectory, 'extension-host.js'),
    extensionRoots: extensionRootsForHost({
        hostOutputDirectory: serverBundleDirectory,
        userDataPath,
        ...(serverBundleDirectory.includes('.asar') &&
            process.resourcesPath && { resourcesPath: process.resourcesPath }),
    }),
    includeTestExtensions: process.env.CAXRI_E2E === '1',
    ...(desktopLaunch && {
        launchDesktop: createDesktopLauncher({
            launch: desktopLaunch,
            userDataPath,
        }),
    }),
    userDataPath,
    version,
});

{
    let isSignalReceived = false;
    const stopForSignal = async (signal: NodeJS.Signals): Promise<void> => {
        if (isSignalReceived) return;
        isSignalReceived = true;
        try {
            await app.stop(signal);
        } finally {
            // This file is the Server Core process entrypoint supervised by a client or platform;
            // an explicit exit after graceful async shutdown is the correct terminal action here,
            // not a throw, which would just surface as an unhandled rejection instead of a clean exit.
            // eslint-disable-next-line unicorn/no-process-exit -- Server Core process entrypoint, not a library
            process.exit(0);
        }
    };
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
}
