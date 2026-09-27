import type { AgentDelegationSettings } from '@caxri/protocol';

import { AgentDelegationService, createDelegationHandlers } from './agent-delegation';
import type { AgentDispatchServiceOptions } from './agent-dispatch';
/**
 * Server domain composition uses the public dispatch boundary required by the repository architecture.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { AgentDispatchService, createAgentCommandHandlers } from './agent-dispatch';
import type { AgentEnvironment } from './agents';
import {
    delegationAdapter,
    readAgentTranscript,
    readDelegationTranscript,
    readVersion,
} from './agents';
import { mainOwned } from './service-handlers';

/**
 * Composes managed Terminal commands with private task ownership and their shared launch dependencies.
 */
export function createAgentCommandRuntime(
    options: AgentDispatchServiceOptions & {
        userDataPath: string;
        agentEnvironment: AgentEnvironment;
        delegationSettings(): AgentDelegationSettings;
    },
) {
    const dispatchService = new AgentDispatchService(options);
    const delegationService = new AgentDelegationService({
        database: options.database,
        delegationSettings: () => options.delegationSettings(),
        dispatch: dispatchService,
        logger: options.logger,
        userDataPath: options.userDataPath,
        dimensions: (terminalId) => options.terminals.dimensions(terminalId),
        inputEpoch: (terminalId) => options.terminals.inputEpoch(terminalId),
        currentLaunchId: (terminalId) =>
            options.terminals.agentProcessId(terminalId) === undefined
                ? undefined
                : options.terminals.agentLaunchId(terminalId),
        isIdle: (terminalId, launchId, turnId) =>
            options.coordinator.hasIdleProof(terminalId, launchId, turnId),
        write: (terminalId, launchId, data, onDelivered) => {
            const accepted = options.terminals.writeAgentExact(
                terminalId,
                data,
                launchId,
                'delegation',
                onDelivered,
            );
            if (accepted) options.coordinator.observeInput(terminalId, data);
            return accepted;
        },
        launchSettings: (provider) => options.launchSettings(provider),
        verifyLaunch: async (launch, provider) =>
            delegationAdapter(provider).verifyVersion(
                await readVersion(provider, launch.executable),
            ),
        readNativeTranscript: (terminalId, sessionId, offset, turnId) =>
            readDelegationTranscript(
                options.database,
                terminalId,
                sessionId,
                offset,
                options.agentEnvironment,
                turnId,
            ),
        readTranscript: (terminalId) =>
            readAgentTranscript(options.database, terminalId, true, options.agentEnvironment),
        /**
         * A Session-scoped records change instead of a dedicated event: the Agent Commander board already refetches on
         * any `state.changed`, and the Workbench answers a Session-only change with one `app.records` read.
         */
        onReceiptChanged: ({ sessionId }) =>
            options.emit({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
            }),
    });
    dispatchService.initialize();
    delegationService.initialize();
    return {
        dispatchService,
        delegationService,
        handlers: {
            ...createDelegationHandlers(delegationService),
            ...createAgentCommandHandlers({ ...options, dispatch: dispatchService, mainOwned }),
        },
    };
}
