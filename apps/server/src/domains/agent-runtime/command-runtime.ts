import type {
    AgentDelegationReceipt,
    AgentDelegationSettings,
    FullStateChangeReason,
} from '@caxri/protocol';

import { AgentDelegationService, createDelegationHandlers } from '../agent-delegation';
import type { AgentDispatchServiceOptions } from '../agent-dispatch';
/**
 * Server domain composition uses the public dispatch boundary required by the repository architecture.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { AgentDispatchService, createAgentCommandHandlers } from '../agent-dispatch';
import type { AgentEnvironment } from '../agents';
import {
    delegationAdapter,
    readAgentTranscript,
    readDelegationTranscript,
    readVersion,
} from '../agents';
import { createCommanderSession, discardCommanderSession } from '../commander';
import { mainOwned } from '../main-owned';

/**
 * Composes managed Terminal commands with private task ownership and their shared launch dependencies.
 */
export function createAgentCommandRuntime(
    options: AgentDispatchServiceOptions & {
        userDataPath: string;
        agentEnvironment: AgentEnvironment;
        delegationSettings(): AgentDelegationSettings;
        /**
         * Feeds every announced delegation receipt change to the Commander completion notifier. Optional so a unit test
         * can construct this runtime without one; the composed Server always passes it.
         */
        onDelegationReceiptChanged?(
            receipt: AgentDelegationReceipt,
            previous?: AgentDelegationReceipt,
        ): void;
    },
) {
    const dispatchService = new AgentDispatchService(options);
    const announce = (reason: FullStateChangeReason) =>
        options.emit({ event: 'state.changed', payload: { kind: 'full', reason } });
    const delegationService = new AgentDelegationService({
        database: options.database,
        delegationSettings: () => options.delegationSettings(),
        dispatch: dispatchService,
        logger: options.logger,
        userDataPath: options.userDataPath,
        commanderSessions: {
            create: (projectId, title) => {
                const sessionId = createCommanderSession(
                    options.database,
                    projectId,
                    options.logger,
                    title,
                );
                announce('session.create');
                return sessionId;
            },
            discard: (sessionId) =>
                discardCommanderSession(options.database, sessionId, options.logger, () =>
                    announce('session.delete'),
                ),
        },
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
        onReceiptChanged: (receipt, previous) => {
            options.emit({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [receipt.sessionId], terminalIds: [] },
            });
            options.onDelegationReceiptChanged?.(receipt, previous);
        },
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
