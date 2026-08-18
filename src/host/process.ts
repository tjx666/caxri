import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY,
    hostDesktopLaunchSchema,
} from '../shared/ipc/desktop-launch';
import { computeBuildFingerprint } from '../shared/node/build-fingerprint';
import { e2eAgentPolicyEnvironment, readE2EAgentPolicy } from '../shared/node/e2e-agent-policy';
import { StructuredLogger } from '../shared/node/logger';
import { installProcessErrorMonitor } from '../shared/node/process-error-monitor';
import { startHostApp } from './app';
import { createDesktopLauncher } from './desktop-launcher';

const userDataPath = process.env.CAXRI_USER_DATA_PATH;
if (!userDataPath) throw new Error('CAXRI_USER_DATA_PATH is required');

const version = typeof __CAXRI_VERSION__ === 'string' ? __CAXRI_VERSION__ : 'unknown';
const commit = typeof __CAXRI_COMMIT__ === 'string' ? __CAXRI_COMMIT__ : 'unknown';
process.env.CAXRI_APP_VERSION = version;
process.env.CAXRI_GIT_COMMIT = commit;
const logger = new StructuredLogger(join(userDataPath, 'logs'), 'host', 'info');
const processErrorMonitor = installProcessErrorMonitor({ processName: 'host' });
processErrorMonitor.attach(logger);
const hostOutputDirectory = dirname(fileURLToPath(import.meta.url));
/**
 * Captured once at startup: this is the fingerprint of the code this Host process is actually running. A later watch
 * rebuild changes the on-disk bundles but not this value, which is exactly what lets the Desktop detect staleness.
 */
const buildId = await computeBuildFingerprint(hostOutputDirectory);
const desktopLaunchSource = process.env[HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY];
const desktopLaunch = desktopLaunchSource
    ? hostDesktopLaunchSchema.parse(JSON.parse(desktopLaunchSource) as unknown)
    : hostOutputDirectory.includes('.asar') && process.resourcesPath
      ? {
            executable: process.execPath,
            args: [],
            cwd: dirname(process.execPath),
        }
      : undefined;
const cliPath =
    process.env.CAXRI_CLI_PATH ??
    (process.resourcesPath
        ? join(process.resourcesPath, 'cli', 'caxri.cjs')
        : join(hostOutputDirectory, '../../packages/cli/dist/caxri.cjs'));

const app = await startHostApp({
    agentHooksPath: process.env.CAXRI_AGENT_HOOKS_PATH,
    buildId,
    commit,
    cliPath,
    executable: process.execPath,
    ...(desktopLaunch && {
        launchDesktop: createDesktopLauncher({
            launch: desktopLaunch,
            userDataPath,
        }),
    }),
    runtimePath: join(hostOutputDirectory, 'runtime.js'),
    runtimeEnvironment: e2eAgentPolicyEnvironment(readE2EAgentPolicy()),
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
            // This file is the Host subprocess entrypoint (forked as its own OS process by Main);
            // an explicit exit after graceful async shutdown is the correct terminal action here,
            // not a throw, which would just surface as an unhandled rejection instead of a clean exit.
            // eslint-disable-next-line unicorn/no-process-exit -- Host subprocess entrypoint, not a library
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
