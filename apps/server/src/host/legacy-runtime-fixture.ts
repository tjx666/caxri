import type { StructuredLogger } from '@caxri/system';

import type { AgentEndpointRegistry } from './agent-endpoints/registry';
import type { HostAppOptions } from './app';
import { HostRuntimeSupervisor } from './runtime-supervisor';

/**
 * Keeps former utility-process fault fixtures runnable only while their tests migrate to direct Core seams.
 */
export function createLegacyRuntimeFixture(
    options: HostAppOptions & { runtimePath: string },
    agentEndpoints: AgentEndpointRegistry,
    logDirectory: string,
    logger: StructuredLogger,
    userDataPath: string,
): HostRuntimeSupervisor {
    return new HostRuntimeSupervisor({
        agentEndpointControl: (request) => {
            switch (request.operation) {
                case 'agent-endpoint.begin':
                    return agentEndpoints.begin(request.params);
                case 'agent-endpoint.activate':
                    return { activated: agentEndpoints.activate(request.params) };
                case 'agent-endpoint.messaging':
                    return { updated: agentEndpoints.updateMessaging(request.params) };
                case 'agent-endpoint.retire':
                    return { retired: agentEndpoints.retire(request.params) };
            }
        },
        agentHooksPath: options.agentHooksPath,
        appVersion: options.version,
        commit: options.commit,
        executable: options.executable,
        extraEnvironment: options.runtimeEnvironment,
        cliPath: options.cliPath,
        logDirectory,
        logger,
        runtimePath: options.runtimePath,
        userDataPath,
    });
}
