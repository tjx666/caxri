import type { AgentChatService } from './agent-chat';
import type { AgentEnvironment, CompactionReadiness } from './agents';
import type { DomainHandlers } from './domain-services';
import type { SessionParkingOptions } from './parking-handlers';
import { detachSessionAgents } from './parking-handlers';
import { AirplaneMode, SessionCompaction } from './session';
import type { TerminalSuspensionService } from './terminal';
import { createInterruptedTerminalRestorer, TerminalRestoreSupervisor } from './terminal';

/**
 * The composition root's restorer options, which also carry the services the compaction needs.
 */
type RestorerOptions = Omit<
    Parameters<typeof createInterruptedTerminalRestorer>[0],
    'terminalRestores'
> & {
    agentEnvironment: AgentEnvironment;
};

/**
 * Owns the Session maintenance slice: the batch compaction (`session.compactWarm`) and Airplane Mode
 * (docs/airplane-mode.md), which compacts through it before parking. Create: the Airplane Mode service, its own restore
 * supervisor (resuming Sessions one after another must not abort the selected Session's restore), and the launch fence
 * on Terminal suspension. Start: finishes an entry or resume a previous Server Core left unfinished. Close: stops the
 * wait and any resume still running.
 */
export function createSessionMaintenanceServices(options: {
    agentChat: AgentChatService;
    compactionReadiness: CompactionReadiness;
    parking: SessionParkingOptions;
    restorerOptions: RestorerOptions;
    terminalSuspension: Pick<TerminalSuspensionService, 'setAirplaneFence'>;
}) {
    const { agentChat, parking } = options;
    const { agentEnvironment, coordinator, database, logger, send, terminals } =
        options.restorerOptions;
    const compaction = new SessionCompaction({
        agentChat,
        database,
        coordinator,
        terminals,
        logger,
        readiness: options.compactionReadiness,
        environment: agentEnvironment,
    });
    const restores = new TerminalRestoreSupervisor();
    const restoreSession = createInterruptedTerminalRestorer({
        ...options.restorerOptions,
        terminalRestores: restores,
    });
    const airplaneMode = new AirplaneMode({
        database,
        compact: () => compaction.run(),
        isCompacting: (terminalId) => coordinator.maintenanceTurns.holds(terminalId),
        hasLiveAgent: (sessionId) =>
            agentChat.liveCount(sessionId) > 0 ||
            database
                .listTerminals(sessionId)
                .some(
                    (terminal) =>
                        terminal.provider !== undefined &&
                        terminals.processId(terminal.id) !== undefined,
                ),
        detach: async (sessionId) => {
            await detachSessionAgents(parking, sessionId);
            parking.sendFullStateChange('session.detach');
        },
        resume: async (sessionId) => {
            // The same relaunch as `session.resume`, without moving any window's selection.
            await parking.mobileTerminalMutations.runSessions([sessionId], () =>
                agentChat.resumeSession(sessionId),
            );
            await restoreSession(sessionId, { includeDetached: true });
            parking.sendFullStateChange('session.resume');
        },
        publish: (state) => send({ event: 'session.airplaneModeChanged', payload: state }),
        logger,
    });
    options.terminalSuspension.setAirplaneFence({
        holds: () => airplaneMode.holds(),
        parked: (sessionId) => airplaneMode.noteParked(sessionId),
    });
    const handlers: Pick<
        DomainHandlers,
        | 'session.airplaneModeStatus'
        | 'session.compactWarm'
        | 'session.enterAirplaneMode'
        | 'session.exitAirplaneMode'
        | 'session.skipAirplaneModeCompaction'
    > = {
        'session.compactWarm': (_parameters, signal) => compaction.run(signal),
        'session.enterAirplaneMode': () => airplaneMode.enter(),
        'session.skipAirplaneModeCompaction': () => airplaneMode.skipCompaction(),
        'session.exitAirplaneMode': ({ sessionIds }) => airplaneMode.exit(sessionIds),
        'session.airplaneModeStatus': () => airplaneMode.status(),
    };
    return {
        handlers,
        start: () => airplaneMode.start(),
        close: () => {
            airplaneMode.close();
            restores.close();
        },
    };
}
