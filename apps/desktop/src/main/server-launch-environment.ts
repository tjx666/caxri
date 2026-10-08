import process from 'node:process';

import type { ServerDesktopLaunch } from '@caxri/protocol';
import { SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY } from '@caxri/protocol';
import type { E2EAgentPolicy } from '@caxri/system';
import {
    e2eAgentPolicyEnvironment,
    EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY,
} from '@caxri/system';

export interface ServerLaunchEnvironmentOptions {
    agentHooksPath?: string;
    cliPath: string;
    desktopLaunch: ServerDesktopLaunch;
    e2eAgentPolicy?: E2EAgentPolicy;
}

/**
 * Curated environment forwarded from Desktop to the spawned Server Core child process. This is an explicit allowlist,
 * not a `process.env` passthrough; see `packages/client/src/supervise/launch.ts`'s `safeLaunchEnvironment()`, which
 * merges a small separate `LAUNCH_ENVIRONMENT_KEYS` allowlist with this curated object (this object always wins on
 * overlap).
 */
export function buildServerLaunchEnvironment(
    options: ServerLaunchEnvironmentOptions,
    processEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    return {
        [SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY]: JSON.stringify(options.desktopLaunch),
        ...e2eAgentPolicyEnvironment(options.e2eAgentPolicy),
        ...(processEnvironment.CAXRI_E2E_WINDOW_MODE && {
            CAXRI_E2E_WINDOW_MODE: processEnvironment.CAXRI_E2E_WINDOW_MODE,
        }),
        ...(processEnvironment.CAXRI_E2E_WORKER_NAMESPACE && {
            CAXRI_E2E_WORKER_NAMESPACE: processEnvironment.CAXRI_E2E_WORKER_NAMESPACE,
        }),
        ...(processEnvironment.CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS && {
            CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS:
                processEnvironment.CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS,
        }),
        ...(processEnvironment.CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS && {
            CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS:
                processEnvironment.CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS,
        }),
        ...(processEnvironment.CAXRI_E2E === '1' && {
            CAXRI_E2E_MOBILE_PAIRING_RESULT_DELAY:
                processEnvironment.CAXRI_E2E_MOBILE_PAIRING_RESULT_DELAY,
            CAXRI_E2E_MOBILE_DROP_SUBMIT_ACK_ONCE:
                processEnvironment.CAXRI_E2E_MOBILE_DROP_SUBMIT_ACK_ONCE,
        }),
        ...(processEnvironment.CAXRI_E2E === '1' &&
            processEnvironment.CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME && {
                CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME:
                    processEnvironment.CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME,
            }),
        ...(processEnvironment[EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY] && {
            [EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY]:
                processEnvironment[EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY],
        }),
        // Lets an unpackaged Desktop serve a locally built Android update (docs/mobile/update.md).
        ...(processEnvironment.CAXRI_MOBILE_UPDATE_DIRECTORY && {
            CAXRI_MOBILE_UPDATE_DIRECTORY: processEnvironment.CAXRI_MOBILE_UPDATE_DIRECTORY,
        }),
        // Idle-exit threshold override (docs/adr/0010-server-core-idle-exit.md); not E2E-gated so
        // `switch-worktree dev` live verification can use a short threshold too.
        ...(processEnvironment.CAXRI_SERVER_IDLE_EXIT_MS && {
            CAXRI_SERVER_IDLE_EXIT_MS: processEnvironment.CAXRI_SERVER_IDLE_EXIT_MS,
        }),
        ...(processEnvironment.CAXRI_TEST_ROOT_PATH && {
            CAXRI_TEST_ROOT_PATH: processEnvironment.CAXRI_TEST_ROOT_PATH,
        }),
        ...(processEnvironment.CAXRI_TEST_ROOT_PATHS && {
            CAXRI_TEST_ROOT_PATHS: processEnvironment.CAXRI_TEST_ROOT_PATHS,
        }),
        // Set by Main's packaged bootstrap (`bootstrap.ts`) so Server Core shares its compile cache directory.
        ...(processEnvironment.CAXRI_COMPILE_CACHE_DIR && {
            CAXRI_COMPILE_CACHE_DIR: processEnvironment.CAXRI_COMPILE_CACHE_DIR,
        }),
        ...(options.agentHooksPath && {
            CAXRI_AGENT_HOOKS_PATH: options.agentHooksPath,
        }),
        CAXRI_CLI_PATH: options.cliPath,
    };
}
