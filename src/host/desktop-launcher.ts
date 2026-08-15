import { spawn } from 'node:child_process';
import process from 'node:process';

import type { HostDesktopLaunch } from '../shared/ipc/desktop-launch';
import { e2eFakeExecutableEnvironmentKeys } from '../shared/node/e2e-agent-policy';
import { safeProcessEnvironment } from '../shared/node/process-environment';

const DESKTOP_E2E_ENVIRONMENT_KEYS = [
    'CAXRI_E2E',
    'CAXRI_E2E_WINDOW_MODE',
    'CAXRI_E2E_WORKER_NAMESPACE',
    'CAXRI_E2E_AGENT_MODE',
    'CAXRI_E2E_AGENT_PROVIDER',
    'CAXRI_TEST_ROOT_PATH',
    'CAXRI_TEST_ROOT_PATHS',
    ...e2eFakeExecutableEnvironmentKeys(),
] as const;

/**
 * Launches the application identity directly; no shell or caller-authored command is accepted.
 */
export function createDesktopLauncher(options: {
    launch: HostDesktopLaunch;
    sourceEnvironment?: NodeJS.ProcessEnv;
    spawnProcess?: typeof spawn;
    userDataPath: string;
}): () => Promise<void> {
    return () =>
        new Promise((resolve, reject) => {
            const source = options.sourceEnvironment ?? process.env;
            const environment: NodeJS.ProcessEnv = {
                ...safeProcessEnvironment(source),
                CAXRI_USER_DATA_DIR: options.userDataPath,
            };
            for (const key of DESKTOP_E2E_ENVIRONMENT_KEYS)
                if (source[key] !== undefined) environment[key] = source[key];
            const child = (options.spawnProcess ?? spawn)(
                options.launch.executable,
                options.launch.args,
                {
                    cwd: options.launch.cwd,
                    detached: true,
                    env: environment,
                    stdio: 'ignore',
                },
            );
            child.once('error', reject);
            child.once('spawn', () => {
                child.unref();
                resolve();
            });
        });
}
