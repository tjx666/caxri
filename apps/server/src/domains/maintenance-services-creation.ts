import { assertE2EAgentInputFromEnvironment } from '@caxri/system';

import type { AgentChatService } from './agent-chat';
import type { AgentEnvironment, CompactionReadiness } from './agents';
import type { DomainHandlers } from './domain-services';
import type { SessionParkingOptions } from './parking-handlers';
import { detachSessionAgents } from './parking-handlers';
import { isPtyTerminal } from './pty-guard';
import { AirplaneMode, SessionCompaction, SessionInterruptCompaction } from './session';
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
 * What a resumed Agent that Airplane Mode stopped mid-work receives. Its background subagents and commands died with
 * it, so it is told to check them rather than wait for their results.
 */
const AIRPLANE_MODE_CONTINUE_PROMPT =
    'Continue where you left off. Caxri Airplane Mode stopped this Agent before going offline, so your last turn was interrupted and any background subagents or commands were stopped; rerun what you still need.';

/**
 * What an Agent whose turn Airplane Mode interrupted receives when the user cancels before anything stopped.
 */
const AIRPLANE_CANCEL_CONTINUE_PROMPT =
    'Continue where you left off. Caxri Airplane Mode interrupted your last turn, then the user cancelled it; nothing else was stopped.';

/**
 * Owns the Session maintenance slice: the batch compaction (`session.compactWarm`) and Airplane Mode
 * (docs/airplane-mode.md), which compacts through it before parking, and interrupt and compact
 * (`session.interruptAndCompact`), which shares Airplane Mode's interrupt. Create: the Airplane Mode service, its own
 * restore supervisor (resuming Sessions one after another must not abort the selected Session's restore), and the
 * launch fence on Terminal suspension. Start: finishes an entry or resume a previous Server Core left unfinished.
 * Close: stops the wait and any resume still running.
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
    const { compactionReadiness } = options;
    /**
     * The Session's primary Agent Terminal, the one compaction and the continue prompt address.
     */
    const primaryAgent = (sessionId: string) => {
        const terminalId = database.getSession(sessionId)?.primaryAgentTerminalId;
        const terminal = terminalId ? database.getTerminal(terminalId) : undefined;
        return terminal?.provider === undefined ? undefined : terminal;
    };
    const isTurnActive = (sessionId: string): boolean => {
        const state = database.getSession(sessionId)?.agentActivityState;
        return state === 'running' || state === 'waiting';
    };
    /**
     * A PTY turn is interrupted only when its composer is proven empty (`CompactionReadiness.armInterrupt`), so the
     * `/compact` typed afterwards cannot submit a draft along with it. Any other running PTY turn stops with its
     * Agent.
     */
    const didInterruptPty = (
        terminalId: string,
        provider: Parameters<typeof assertE2EAgentInputFromEnvironment>[0],
    ): boolean => {
        const launchId = terminals.agentLaunchId(terminalId);
        if (!launchId || !compactionReadiness.armInterrupt(terminalId, launchId)) return false;
        assertE2EAgentInputFromEnvironment(provider);
        // `maintenance` input reaches `CompactionReadiness.input`, which turns the armed proof ready on this Escape.
        if (!terminals.writeAgentExact(terminalId, '\u{1B}', launchId, 'maintenance')) {
            // The write counted as input before it was refused, which turned the armed proof ready: revoke it.
            compactionReadiness.forget(terminalId);
            return false;
        }
        coordinator.observeInput(terminalId, '\u{1B}');
        return true;
    };
    /**
     * Interrupts the Session's running turn without stopping its Agent, so the batch compaction can reach it.
     */
    const didInterruptTurn = async (sessionId: string): Promise<boolean> => {
        const terminal = primaryAgent(sessionId);
        if (!terminal) return false;
        if (isPtyTerminal(terminal))
            return (
                database.getSession(sessionId)?.agentActivityState === 'running' &&
                didInterruptPty(terminal.id, terminal.provider)
            );
        if (!agentChat.hasActiveTurn(terminal.id)) return false;
        await agentChat.interrupt(terminal.id);
        return true;
    };
    const isTurnRunning = (sessionId: string): boolean => {
        const terminal = primaryAgent(sessionId);
        if (terminal && !isPtyTerminal(terminal)) return agentChat.hasActiveTurn(terminal.id);
        return database.getSession(sessionId)?.agentActivityState === 'running';
    };
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
        isWorking: (sessionId) => {
            if (isTurnActive(sessionId)) return true;
            const terminal = primaryAgent(sessionId);
            if (!terminal) return false;
            if (!isPtyTerminal(terminal))
                return (
                    agentChat.hasActiveTurn(terminal.id) ||
                    agentChat.states.hasRunningTasks(sessionId)
                );
            // Claude's background subagents, workflows, monitors, and non-server background commands
            // (`agentBackgroundWork`); a dev server left running in the background does not count.
            return coordinator.agentOperation(terminal.id) === 'background';
        },
        interrupt: didInterruptTurn,
        isTurnRunning,
        continueLive: async (sessionId) => {
            const terminal = primaryAgent(sessionId);
            if (!terminal) return;
            if (!isPtyTerminal(terminal)) {
                await agentChat.send(terminal.id, { text: AIRPLANE_CANCEL_CONTINUE_PROMPT });
                return;
            }
            const launchId = terminals.agentLaunchId(terminal.id);
            // The interrupt proved the composer empty, so the prompt is submitted on its own.
            if (launchId)
                await terminals.submitAgentExact(
                    terminal.id,
                    sessionId,
                    launchId,
                    AIRPLANE_CANCEL_CONTINUE_PROMPT,
                );
        },
        detach: async (sessionId) => {
            await detachSessionAgents(parking, sessionId);
            parking.sendFullStateChange('session.detach');
        },
        resume: async (sessionId, shouldContinue) => {
            // The same relaunch as `session.resume`, without moving any window's selection.
            await parking.mobileTerminalMutations.runSessions([sessionId], () =>
                agentChat.resumeSession(sessionId),
            );
            const terminal = shouldContinue ? primaryAgent(sessionId) : undefined;
            await restoreSession(sessionId, {
                includeDetached: true,
                ...(terminal &&
                    isPtyTerminal(terminal) && {
                        agentPrompt: {
                            terminalId: terminal.id,
                            text: AIRPLANE_MODE_CONTINUE_PROMPT,
                        },
                    }),
            });
            // A Chat queues the message behind its own start, so it can be sent right after `resumeSession`.
            if (terminal && !isPtyTerminal(terminal))
                await agentChat.send(terminal.id, { text: AIRPLANE_MODE_CONTINUE_PROMPT });
            parking.sendFullStateChange('session.resume');
        },
        publish: (state) => send({ event: 'session.airplaneModeChanged', payload: state }),
        logger,
    });
    const interruptCompaction = new SessionInterruptCompaction({
        listSessionIds: () =>
            database
                .listVisibleSessions()
                .filter((session) => session.archivedAt === undefined)
                .map((session) => session.id),
        isTurnRunning,
        interrupt: didInterruptTurn,
        compact: (signal) => compaction.run(signal),
        isAirplaneModeActive: () => airplaneMode.status().phase !== 'off',
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
        | 'session.interruptAndCompact'
        | 'session.skipAirplaneModeCompaction'
    > = {
        'session.compactWarm': (_parameters, signal) => compaction.run(signal),
        'session.interruptAndCompact': (_parameters, signal) => interruptCompaction.run(signal),
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
