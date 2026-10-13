import type {
    AgentDispatchFailure,
    AgentDispatchReceipt,
    AgentDispatchResumeParams as AgentDispatchResumeParameters,
    AgentDispatchStartParams as AgentDispatchStartParameters,
    AgentDispatchWaitResult,
    AgentEndpointRef as AgentEndpointReference,
    AgentLaunchSettings,
    Principal,
    ProcessState,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError, isChatTerminal, toWireError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

/**
 * Server domains expose public root barrels by architecture contract; structure tests reject deep provider imports.
 */
// oxlint-disable-next-line react-doctor/no-barrel-import
import { agentProviders } from '../agents';
import { SingleFlight } from '../single-flight';
import type { TerminalLifecycleCause, TerminalWorkingDirectoryIdentity } from '../terminal';
import { launchChat } from './chat-launch';
import { isAgentLive, requireDispatchChats } from './chat-target';
import { DispatchWaiters } from './dispatch-waiters';
import { dispatchFingerprint, launchProjection } from './launch-projection';
import { isSettled, terminalStatePatch } from './receipt-status';
import type { AgentDispatchServiceOptions } from './service-options';

type DispatchReason = AgentDispatchFailure['reason'];
type TransitionReason =
    | TerminalLifecycleCause
    | 'created'
    | 'launchStarted'
    | 'launchReady'
    | 'launchFailed'
    | 'processFailed'
    | 'agentExit'
    | 'terminalSuspended'
    | 'userDetached'
    | 'processInterrupted';

export interface AgentDispatchStartOptions {
    delegationId?: string;
    assignedAgentSessionId?: string;
    initialPrompt?: string;
    launch: AgentLaunchSettings;
    shouldStart?: () => boolean;
    cwd?: string;
    /**
     * Checks current layout capacity after async path validation, immediately before durable creation.
     */
    beforeCreate?(): void;
    /**
     * Runs after durable Terminal creation and before any provider process can start.
     */
    prepared(terminal: TerminalRecord): void;
}

/**
 * Delegation-only recovery of one frozen native session; ordinary dispatch cannot replace a running Agent.
 */
export interface AgentDispatchResumeOptions {
    delegationId?: string;
    launch: AgentLaunchSettings;
    initialPrompt: string;
    replaceLaunchId?: string;
    shouldStart?: () => boolean;
    beforeResume(): void;
}

/**
 * Server-owned dispatch lifecycle with durable idempotency before the first PTY side effect.
 */
export class AgentDispatchService {
    private readonly inFlight = new SingleFlight<string, AgentDispatchReceipt>();
    private readonly intentionalRestarts = new Map<string, string>();
    private readonly now: () => number;
    private readonly waiters = new DispatchWaiters();
    private readonly receipt = (dispatchId: string) =>
        this.options.database.getAgentDispatch(dispatchId)?.receipt;

    constructor(private readonly options: AgentDispatchServiceOptions) {
        this.now = options.now ?? Date.now;
    }

    private async startOnce(
        dispatchId: string,
        principal: Principal,
        input: AgentDispatchStartParameters,
        options?: AgentDispatchStartOptions,
    ): Promise<AgentDispatchReceipt> {
        const fingerprint = dispatchFingerprint(principal, 'start', input);
        const existing = this.existing(dispatchId, fingerprint);
        if (existing) return existing;
        const session = this.targetSession(input.projectId, input.sessionId);
        const ownerProject = this.options.database.getProject(session.projectId);
        if (!ownerProject) throw new CaxriError('NOT_FOUND', 'Project not found');
        const launch = options?.launch ?? this.options.launchSettings(input.provider);
        const projected = launchProjection(
            input.provider,
            launch,
            'fresh',
            (options?.assignedAgentSessionId ? 2 : 0) + (options?.initialPrompt ? 2 : 0),
        );
        // The Terminal record does not exist until the working directory resolves; a detach meanwhile must still wait.
        const prepared = this.options.terminals.launches.begin(session.id);
        let launched: Promise<AgentDispatchReceipt>;
        try {
            const cwd = await this.options.terminalWorkingDirectory({
                authorizedRoots: [ownerProject.rootPath, session.rootPath],
                defaultRoot: options?.cwd ?? session.rootPath,
            });
            const identity = await this.options.terminalDirectoryIdentity(cwd);
            options?.beforeCreate?.();
            const previousLayout = this.options.database.getSessionState(
                input.sessionId,
            ).paneLayout;
            const { stored, terminal } = this.options.database.createAgentDispatchWithTerminal(
                {
                    dispatchId,
                    requestFingerprint: fingerprint,
                    operation: 'start',
                    projectId: input.projectId,
                    sessionId: input.sessionId,
                    provider: input.provider,
                    requestedLaunch: projected,
                    effectiveLaunch: projected,
                    now: this.now(),
                },
                input.provider,
                cwd,
            );
            this.logTransition(stored.receipt, 'created');
            this.publish(stored.receipt);
            try {
                options?.prepared(terminal);
            } catch (error) {
                // Preparation is synchronous and no process exists yet; restore the exact pre-insert layout.
                this.options.database.closeTerminal(terminal.id);
                const state = this.options.database.getSessionState(input.sessionId);
                this.options.database.updateSessionState({ ...state, paneLayout: previousLayout });
                return this.fail(dispatchId, error, 'launch_failed');
            }
            try {
                this.options.emit({
                    event: 'state.changed',
                    payload: { kind: 'full', reason: 'terminal.create' },
                });
                this.options.coordinator.prepareTerminalStart(terminal.id);
            } catch (error) {
                return this.fail(dispatchId, error, 'launch_failed');
            }
            // `launch` calls `start` before its first await, so the span may end before the readiness wait.
            launched = this.launch(
                dispatchId,
                terminal,
                identity,
                undefined,
                launch,
                options?.shouldStart,
                options?.initialPrompt,
                options?.delegationId,
                options?.assignedAgentSessionId,
            );
        } finally {
            prepared();
        }
        return launched;
    }

    private async resumeOnce(
        dispatchId: string,
        principal: Principal,
        input: AgentDispatchResumeParameters,
        operation: 'resume' | 'wake',
        requestFingerprint?: string,
        options?: AgentDispatchResumeOptions,
    ): Promise<AgentDispatchReceipt> {
        const fingerprint = requestFingerprint ?? dispatchFingerprint(principal, operation, input);
        const existing = this.existing(dispatchId, fingerprint);
        if (existing) return existing;
        const terminal = this.targetTerminal(input);
        if (!terminal.provider || terminal.kind === 'shell')
            throw new CaxriError('CONFLICT', 'Dispatch resume requires an Agent Terminal');
        if (terminal.agentSessionId !== input.providerSessionId)
            throw new CaxriError('UNAVAILABLE', 'Provider session binding changed');
        const expectedLaunchId = this.options.terminals.agentLaunchId(terminal.id);
        if (
            isAgentLive(this.options.terminals, this.options.agentChat, terminal) &&
            (!options?.replaceLaunchId || options.replaceLaunchId !== expectedLaunchId)
        )
            throw new CaxriError('CONFLICT', 'Agent Terminal is already running');
        const launch = options?.launch ?? this.options.launchSettings(terminal.provider);
        const resumeArguments = agentProviders[terminal.provider].resumeArguments(
            input.providerSessionId,
        );
        const requested = launchProjection(terminal.provider, launch, 'resume');
        const effective = launchProjection(
            terminal.provider,
            launch,
            'resume',
            resumeArguments.length + (options?.initialPrompt ? 2 : 0),
        );
        const stored = this.options.database.createAgentDispatch({
            dispatchId,
            requestFingerprint: fingerprint,
            operation,
            projectId: input.projectId,
            sessionId: input.sessionId,
            terminalId: terminal.id,
            provider: terminal.provider,
            requestedLaunch: requested,
            effectiveLaunch: effective,
            now: this.now(),
        });
        this.logTransition(stored.receipt, 'created');
        this.publish(stored.receipt);
        this.update(dispatchId, { status: 'starting', terminalId: terminal.id });
        // A detach that starts during the lookup below must still wait for the launch it precedes.
        const prepared = this.options.terminals.launches.begin(terminal.sessionId);
        let launched: Promise<AgentDispatchReceipt>;
        try {
            let identity: TerminalWorkingDirectoryIdentity;
            try {
                identity = await this.options.terminalDirectoryIdentity(terminal.cwd);
                this.assertNotArchived(input.sessionId);
                if (
                    options &&
                    this.options.terminals.agentLaunchId(terminal.id) !== expectedLaunchId
                )
                    throw new CaxriError('CONFLICT', 'Agent generation changed before resume');
                options?.beforeResume();
                this.options.coordinator.prepareTerminalResume(terminal.id);
            } catch (error) {
                return this.fail(dispatchId, error, 'launch_failed');
            }
            launched = this.launch(
                dispatchId,
                terminal,
                identity,
                input.providerSessionId,
                launch,
                options?.shouldStart,
                options?.initialPrompt,
                options?.delegationId,
            );
        } finally {
            prepared();
        }
        return launched;
    }

    private async launch(
        dispatchId: string,
        terminal: TerminalRecord,
        expectedWorkingDirectory: TerminalWorkingDirectoryIdentity,
        resumeAgentSessionId?: string,
        launchSettings?: AgentLaunchSettings,
        shouldStart?: () => boolean,
        initialPrompt?: string,
        delegationId?: string,
        assignedAgentSessionId?: string,
    ): Promise<AgentDispatchReceipt> {
        if (isChatTerminal(terminal))
            return launchChat(
                this.options,
                { terminal, initialPrompt, shouldStart },
                {
                    update: (patch) => this.update(dispatchId, patch),
                    interrupt: () => this.interrupt(dispatchId, terminal.id),
                    fail: (error) => this.fail(dispatchId, error, 'launch_failed'),
                },
            );
        try {
            if (resumeAgentSessionId) this.intentionalRestarts.set(terminal.id, dispatchId);
            try {
                await (resumeAgentSessionId
                    ? this.options.terminals.restart(terminal.id, {
                          expectedWorkingDirectory,
                          resumeAgentSessionId,
                          launchSettings,
                          shouldStart,
                          initialPrompt,
                          delegationId,
                      })
                    : this.options.terminals.start(terminal, {
                          expectedWorkingDirectory,
                          launchSettings,
                          shouldStart,
                          delegationId,
                          initialPrompt,
                          assignedAgentSessionId,
                      }));
            } finally {
                if (this.intentionalRestarts.get(terminal.id) === dispatchId)
                    this.intentionalRestarts.delete(terminal.id);
            }
            if (shouldStart && !shouldStart()) return this.interrupt(dispatchId, terminal.id);
            await this.options.terminals.waitForAgentRunning(terminal.id);
            const running = this.options.database.getTerminal(terminal.id);
            const currentEndpoint = this.options.endpoints?.endpointForTerminal(terminal.id);
            const controlTarget =
                currentEndpoint ?? this.options.endpoints?.preparedEndpointForTerminal(terminal.id);
            if (
                running?.lastAgentProcessState !== 'running' ||
                this.options.terminals.agentProcessId(terminal.id) === undefined
            ) {
                if (controlTarget)
                    this.options.terminals.signalAgentExact(
                        terminal.id,
                        controlTarget.launchId,
                        'SIGHUP',
                    );
                throw new CaxriError('UNAVAILABLE', 'Managed Agent did not become running');
            }
            if (!currentEndpoint) {
                if (controlTarget)
                    this.options.terminals.signalAgentExact(
                        terminal.id,
                        controlTarget.launchId,
                        'SIGHUP',
                    );
                throw new CaxriError('UNAVAILABLE', 'Agent Endpoint did not become active');
            }
            if (shouldStart && !shouldStart()) return this.interrupt(dispatchId, terminal.id);
            const receipt = this.update(dispatchId, {
                status: 'running',
                terminalId: terminal.id,
                endpoint: currentEndpoint.ref,
            });
            this.options.database.touchSessionActivity(terminal.sessionId, 'agent_started');
            this.options.coordinator.probeTerminal(terminal.id);
            this.options.emit({
                event: 'state.changed',
                payload: {
                    kind: 'records',
                    sessionIds: [terminal.sessionId],
                    terminalIds: [terminal.id],
                },
            });
            return receipt;
        } catch (error) {
            return this.fail(dispatchId, error, 'launch_failed');
        }
    }

    private existing(dispatchId: string, fingerprint: string): AgentDispatchReceipt | undefined {
        const existing = this.options.database.getAgentDispatch(dispatchId);
        if (!existing) return undefined;
        if (existing.requestFingerprint !== fingerprint)
            throw new CaxriError(
                'VALIDATION',
                'A dispatch ID cannot be reused for different command input',
            );
        return existing.receipt;
    }

    private targetSession(projectId: string, sessionId: string) {
        const session = this.options.database.getSession(sessionId);
        if (!session || session.projectId !== projectId)
            throw new CaxriError('NOT_FOUND', 'Dispatch Session was not found in the Project');
        this.assertNotArchived(sessionId);
        return session;
    }

    /**
     * Dispatch does not join the Session mutation queue, and `session.archive` parks only the Terminals live when it
     * runs, so every await before a launch must re-check archive state. A fresh start re-checks inside the
     * receipt/Terminal insert transaction instead (`createAgentDispatchWithTerminal`).
     */
    private assertNotArchived(sessionId: string): void {
        if (this.options.database.getSession(sessionId)?.archivedAt !== undefined)
            throw new CaxriError('CONFLICT', 'Restore the archived Session before dispatching');
    }

    private targetTerminal(target: {
        projectId: string;
        sessionId: string;
        terminalId: string;
    }): TerminalRecord {
        this.targetSession(target.projectId, target.sessionId);
        const terminal = this.options.database.getTerminal(target.terminalId);
        if (!terminal || terminal.sessionId !== target.sessionId)
            throw new CaxriError('NOT_FOUND', 'Dispatch Terminal was not found in the Session');
        // Before the receipt is persisted: a Chat resumes through Agent Chat, which this Server may lack.
        if (isChatTerminal(terminal)) requireDispatchChats(terminal, this.options.agentChat);
        return terminal;
    }

    /**
     * Settles a dispatch whose Terminal stopped being its own while the launch was in flight.
     *
     * `terminals.start`/`restart` joins a launch already under way, so a manual restart that wins the race still
     * returns successfully here and the process that came up belongs to the user. Delegation already reports
     * `interrupted`/`target_changed` for that case, but the receipt went on to claim `running` on the same Terminal,
     * leaving `agent.dispatch.status` and the diagnostics disagreeing with the delegation they describe.
     *
     * The process is deliberately left running, unlike every other failure exit from `launch`: it is the user's Agent
     * now, and killing it to tidy up a lost delegation is far worse than the stale receipt this fixes.
     */
    private interrupt(dispatchId: string, terminalId: string): AgentDispatchReceipt {
        const settled = this.receipt(dispatchId);
        if (settled && isSettled(settled)) return settled;
        return this.update(
            dispatchId,
            {
                status: 'interrupted',
                terminalId,
                failure: { code: 'CONFLICT', reason: 'target_changed' },
            },
            'processInterrupted',
        );
    }

    private fail(dispatchId: string, error: unknown, reason: DispatchReason): AgentDispatchReceipt {
        /**
         * A suspension or detach racing the launch settles the receipt as `interrupted` before the launch promise
         * rejects; the waiter has already seen that outcome, so it must not be rewritten as a failure.
         */
        const settled = this.receipt(dispatchId);
        if (settled && isSettled(settled)) return settled;
        const wire = toWireError(error);
        return this.update(dispatchId, {
            status: 'failed',
            failure: { code: wire.code, reason },
        });
    }

    /**
     * `isAnnounced` is false only for Server restart retirement, which runs before the durable event journal exists.
     */
    private update(
        dispatchId: string,
        patch: {
            status: AgentDispatchReceipt['status'];
            terminalId?: string;
            endpoint?: AgentEndpointReference;
            failure?: AgentDispatchFailure;
        },
        reason?: TransitionReason,
        isAnnounced = true,
    ): AgentDispatchReceipt {
        const previous = this.receipt(dispatchId);
        const stored = this.options.database.updateAgentDispatch(dispatchId, {
            ...patch,
            now: this.now(),
        });
        if (previous?.status !== stored.receipt.status)
            this.logTransition(
                stored.receipt,
                reason ??
                    (patch.failure?.reason === 'host_reset'
                        ? 'hostRestart'
                        : patch.failure?.reason === 'launch_failed'
                          ? 'launchFailed'
                          : patch.status === 'failed'
                            ? 'processFailed'
                            : patch.status === 'running'
                              ? 'launchReady'
                              : 'launchStarted'),
                previous?.status,
            );
        if (isAnnounced) this.publish(stored.receipt);
        return stored.receipt;
    }

    private logTransition(
        receipt: AgentDispatchReceipt,
        reason: TransitionReason,
        previous?: AgentDispatchReceipt['status'],
    ): void {
        this.options.logger.write('info', logEventCatalog.agentDispatch.transitioned, {
            fields: {
                dispatchId: receipt.dispatchId,
                terminalId: receipt.terminalId ?? null,
                previousStatus: previous ?? null,
                status: receipt.status,
                reason,
                durationMs: Math.max(0, this.now() - receipt.createdAt),
            },
        });
    }

    private publish(receipt: AgentDispatchReceipt): void {
        this.options.emit({ event: 'agent.dispatch.changed', payload: receipt });
        this.waiters.publish(receipt);
    }

    initialize(): void {
        /**
         * A Server restart cannot retain its PTY/Endpoint proof; never retry an ambiguous spawn. Retiring stays silent:
         * the journal's bounded startup queue holds fewer events than the receipt table holds rows, no wait can be
         * pending yet, and nothing reads these events at startup: Desktop windows reload on reconnect, and a later
         * `status` or `wait` reads the retired receipt itself.
         */
        for (const { receipt } of this.options.database.activeAgentDispatches())
            this.update(
                receipt.dispatchId,
                { status: 'failed', failure: { code: 'UNAVAILABLE', reason: 'host_reset' } },
                undefined,
                false,
            );
    }

    start(
        dispatchId: string,
        principal: Principal,
        input: AgentDispatchStartParameters,
        options?: AgentDispatchStartOptions,
    ): Promise<AgentDispatchReceipt> {
        return this.inFlight.run(dispatchId, () =>
            this.startOnce(dispatchId, principal, input, options),
        );
    }

    resume(
        dispatchId: string,
        principal: Principal,
        input: AgentDispatchResumeParameters,
        options?: AgentDispatchResumeOptions,
    ): Promise<AgentDispatchReceipt> {
        return this.inFlight.run(dispatchId, () =>
            this.resumeOnce(dispatchId, principal, input, 'resume', undefined, options),
        );
    }

    wake(
        dispatchId: string,
        principal: Principal,
        target: { projectId: string; sessionId: string; terminalId: string },
    ): Promise<AgentDispatchReceipt> {
        return this.inFlight.run(dispatchId, async () => {
            const fingerprint = dispatchFingerprint(principal, 'wake', target);
            const existing = this.existing(dispatchId, fingerprint);
            if (existing) return existing;
            const terminal = this.targetTerminal(target);
            if (!terminal.agentSessionId)
                throw new CaxriError(
                    'UNAVAILABLE',
                    'Stopped Agent has no resumable Provider session',
                );
            return this.resumeOnce(
                dispatchId,
                principal,
                { ...target, providerSessionId: terminal.agentSessionId },
                'wake',
                fingerprint,
            );
        });
    }

    status(dispatchId: string, projectScope: readonly string[] | null): AgentDispatchReceipt {
        const stored = this.options.database.getAgentDispatch(dispatchId);
        if (!stored || (projectScope && !projectScope.includes(stored.receipt.projectId)))
            throw new CaxriError('NOT_FOUND', 'Agent dispatch receipt was not found');
        return stored.receipt;
    }

    wait(
        dispatchId: string,
        projectScope: readonly string[] | null,
        afterRevision: number,
        timeoutMs: number,
        waitId: string,
    ): Promise<AgentDispatchWaitResult> {
        const current = this.status(dispatchId, projectScope);
        if (current.revision > afterRevision || isSettled(current))
            return Promise.resolve({ receipt: current, outcome: 'changed' });
        return this.waiters.wait(dispatchId, afterRevision, timeoutMs, waitId, () =>
            this.status(dispatchId, projectScope),
        );
    }

    cancelWait(waitId: string): boolean {
        return this.waiters.cancel(waitId, this.receipt);
    }

    observeTerminalState(
        terminalId: string,
        state: ProcessState,
        cause?: TerminalLifecycleCause,
    ): void {
        for (const { receipt } of this.options.database.agentDispatchesForTerminal(terminalId)) {
            if (isSettled(receipt)) continue;
            if (
                state === 'interrupted' &&
                receipt.status === 'starting' &&
                this.intentionalRestarts.get(terminalId) === receipt.dispatchId
            )
                continue;
            if (state === 'starting') {
                if (receipt.status === 'running')
                    this.update(
                        receipt.dispatchId,
                        { status: 'interrupted' },
                        'processInterrupted',
                    );
                continue;
            }
            const patch = terminalStatePatch(state);
            if (!patch) continue;
            /**
             * A process exit before launch proof is a failed launch, even with exit code zero. Preserve intentional
             * interruption instead of rewriting the result after its waiter has already observed it.
             */
            if (
                cause === undefined &&
                receipt.status !== 'running' &&
                (patch.status === 'stopped' || patch.status === 'failed')
            ) {
                this.update(
                    receipt.dispatchId,
                    { status: 'failed', failure: { code: 'UNAVAILABLE', reason: 'launch_failed' } },
                    'launchFailed',
                );
                continue;
            }
            const reason: TransitionReason =
                cause ??
                (state === 'suspended'
                    ? 'terminalSuspended'
                    : state === 'detached'
                      ? 'userDetached'
                      : patch.status === 'failed'
                        ? 'processFailed'
                        : patch.status === 'stopped'
                          ? 'agentExit'
                          : 'processInterrupted');
            this.update(receipt.dispatchId, patch, reason);
        }
    }

    close(): void {
        this.waiters.close(this.receipt);
    }
}
