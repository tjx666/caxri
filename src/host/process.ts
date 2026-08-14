import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY,
    hostDesktopLaunchSchema,
} from '../shared/ipc/desktop-launch';
import { StructuredLogger } from '../shared/node/logger';
import { installProcessErrorMonitor } from '../shared/node/process-error-monitor';
import { e2eAgentPolicyEnvironment, readE2EAgentPolicy } from '../shared/node/e2e-agent-policy';
import { startHostApplication } from './application';
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

const application = await startHostApplication({
    agentHooksPath: process.env.CAXRI_AGENT_HOOKS_PATH,
    commit,
    cliPath,
    executable: process.execPath,
    ...(desktopLaunch
        ? {
              launchDesktop: createDesktopLauncher({
                  launch: desktopLaunch,
                  userDataPath,
              }),
          }
        : {}),
    runtimePath: join(hostOutputDirectory, 'runtime.js'),
    runtimeEnvironment: e2eAgentPolicyEnvironment(readE2EAgentPolicy()),
    userDataPath,
    version,
});

let signalReceived = false;
const stopForSignal = (signal: NodeJS.Signals): void => {
    if (signalReceived) return;
    signalReceived = true;
    void application.stop(signal).finally(() => process.exit(0));
};
process.once('SIGINT', stopForSignal);
process.once('SIGTERM', stopForSignal);
