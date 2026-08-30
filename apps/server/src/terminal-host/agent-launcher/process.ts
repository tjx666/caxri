import { isAbsolute } from 'node:path';
import process from 'node:process';

import { runManagedAgentLauncher } from './client';
import { MANAGED_AGENT_LAUNCHER_FLAG } from './protocol';

export interface ManagedAgentLauncherProcessArguments {
    socketPath: string;
    launchId: string;
}

export interface RunManagedAgentLauncherProcessOptions {
    argv?: readonly string[];
    environment?: NodeJS.ProcessEnv;
}

export function parseManagedAgentLauncherProcessArguments(
    argv: readonly string[],
): ManagedAgentLauncherProcessArguments | undefined {
    if (
        argv.length !== 3 ||
        argv[0] !== MANAGED_AGENT_LAUNCHER_FLAG ||
        !isAbsolute(argv[1]) ||
        argv[1].length > 4_096 ||
        argv[2].length === 0 ||
        argv[2].length > 256
    ) {
        return undefined;
    }
    return { socketPath: argv[1], launchId: argv[2] };
}

/**
 * Runs the private launcher mode without terminating the containing process. The Terminal Host entrypoint remains the
 * owner of assigning the returned exit code when it selects this mode before normal Host initialization.
 */
export async function runManagedAgentLauncherProcess(
    options: RunManagedAgentLauncherProcessOptions = {},
): Promise<number> {
    const environment = options.environment ?? process.env;
    const parsed = parseManagedAgentLauncherProcessArguments(options.argv ?? process.argv.slice(2));
    if (
        !parsed ||
        (environment.CAXRI_AGENT_LAUNCHER_SOCKET !== undefined &&
            environment.CAXRI_AGENT_LAUNCHER_SOCKET !== parsed.socketPath) ||
        (environment.CAXRI_AGENT_LAUNCHER_ID !== undefined &&
            environment.CAXRI_AGENT_LAUNCHER_ID !== parsed.launchId)
    ) {
        delete environment.CAXRI_AGENT_LAUNCHER_TOKEN;
        return 1;
    }

    try {
        const result = await runManagedAgentLauncher({
            environment,
            launchId: parsed.launchId,
            socketPath: parsed.socketPath,
        });
        return result.exitCode ?? 1;
    } catch {
        return 1;
    }
}

if (import.meta.main) process.exitCode = await runManagedAgentLauncherProcess();
