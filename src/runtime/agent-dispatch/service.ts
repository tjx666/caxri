import { createHash } from 'node:crypto';

import { agentProviderCatalog, type AgentLaunchSettings } from '../../shared/agents';
import type {
    AgentDispatchFailure,
    AgentDispatchLaunch,
    AgentDispatchReceipt,
    AgentDispatchResumeParams,
    AgentDispatchStartParams,
    AgentDispatchWaitResult,
} from '../../shared/ipc/agent-dispatch-contract';
import type { AgentEndpointRef } from '../../shared/ipc/agent-endpoint-contract';
import { CaxriError, toWireError } from '../../shared/ipc/errors';
import type { RuntimeEvent } from '../../shared/ipc/events';
import type { Principal } from '../../shared/ipc/principal';
import type { AgentProvider, ProcessState, TerminalRecord } from '../../shared/types';
import type { AgentCoordinator } from '../agents';
import type { RuntimeAgentEndpointLifecycle } from '../agent-endpoints';
import type { CaxriDatabase } from '../db';
import { SingleFlight } from '../single-flight';
import type { TerminalManager, TerminalWorkingDirectoryIdentity } from '../terminal';

interface DispatchWaiter {
    afterRevision: number;
    resolve(result: AgentDispatchWaitResult): void;
    timer: NodeJS.Timeout;
    waitId: string;
}

const MAX_DISPATCH_WAITERS = 256;
const MAX_WAITERS_PER_DISPATCH = 32;

export interface AgentDispatchServiceOptions {
    database: CaxriDatabase;
    endpoints?: RuntimeAgentEndpointLifecycle;
    coordinator: AgentCoordinator;
    terminals: TerminalManager;
    launchSettings(provider: AgentProvider): AgentLaunchSettings;
    terminalDirectoryIdentity(path: string): Promise<TerminalWorkingDirectoryIdentity>;
    terminalWorkingDirectory(projectRoot: string): Promise<string>;
    emit(event: RuntimeEvent): void;
    now?: () => number;
}

type DispatchReason = AgentDispatchFailure['reason'];

function dispatchFingerprint(principal: Principal, operation: string, input: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify({ principal, operation, input }))
        .digest('hex');
}

function launchFingerprint(launch: AgentLaunchSettings): string {
    return createHash('sha256').update(JSON.stringify(launch)).digest('hex');
}

function launchProjection(
    provider: AgentProvider,
    launch: AgentLaunchSettings,
    mode: AgentDispatchLaunch['mode'],
    resumeArgumentCount = 0,
): AgentDispatchLaunch {
    return {
        provider,
        mode,
        executable: launch.executable,
        argumentCount: launch.args.length + resumeArgumentCount,
        fingerprint: launchFingerprint({
            executable: launch.executable,
            args:
                resumeArgumentCount === 0
                    ? launch.args
                    : [...launch.args, `<${resumeArgumentCount} provider resume arguments>`],
        }),
    };
}

function settled(receipt: AgentDispatchReceipt): boolean {
    return ['stopped', 'interrupted', 'failed'].includes(receipt.status);
}

/** Runtime-owned dispatch lifecycle with durable idempotency before the first PTY side effect. */
export class AgentDispatchService {
    private readonly inFlight = new SingleFlight<string, AgentDispatchReceipt>();
    private readonly now: () => number;
    private readonly waiters = new Map<string, Set<DispatchWaiter>>();

    constructor(private readonly options: AgentDispatchServiceOptions) {
        this.now = options.now ?? Date.now;
    }

    initialize(): void {
        /** A Runtime restart cannot retain its PTY/Endpoint proof; never retry an ambiguous spawn. */
        for (const { receipt } of this.options.database.activeAgentDispatches())
            this.update(receipt.dispatchId, {
                status: 'failed',
                failure: { code: 'UNAVAILABLE', reason: 'host_reset' },
            });
    }

    start(
        dispatchId: string,
        principal: Principal,
        input: AgentDispatchStartParams,
    ): Promise<AgentDispatchReceipt> {
        return this.inFlight.run(dispatchId, () => this.startOnce(dispatchId, principal, input));
    }

    resume(
        dispatchId: string,
        principal: Principal,
        input: AgentDispatchResumeParams,
    ): Promise<AgentDispatchReceipt> {
        return this.inFlight.run(dispatchId, () =>
            this.resumeOnce(dispatchId, principal, input, 'resume'),
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
        if (current.revision > afterRevision || settled(current))
            return Promise.resolve({ receipt: current, outcome: 'changed' });
        const waiters = this.waiters.get(dispatchId) ?? new Set();
        const waiterCount = [...this.waiters.values()].reduce(
            (count, group) => count + group.size,
            0,
        );
        if (waiterCount >= MAX_DISPATCH_WAITERS || waiters.size >= MAX_WAITERS_PER_DISPATCH)
            throw new CaxriError('CAPACITY', 'Too many Agent dispatch waits are pending');
        return new Promise((resolve) => {
            const waiter: DispatchWaiter = {
                afterRevision,
                resolve,
                timer: setTimeout(() => {
                    const currentWaiters = this.waiters.get(dispatchId);
                    currentWaiters?.delete(waiter);
                    if (currentWaiters?.size === 0) this.waiters.delete(dispatchId);
                    resolve({
                        receipt: this.status(dispatchId, projectScope),
                        outcome: 'timed_out',
                    });
                }, timeoutMs),
                waitId,
            };
            waiter.timer.unref();
            waiters.add(waiter);
            this.waiters.set(dispatchId, waiters);
        });
    }

    cancelWait(waitId: string): boolean {
        let canceled = false;
        for (const [dispatchId, waiters] of this.waiters) {
            const receipt = this.options.database.getAgentDispatch(dispatchId)?.receipt;
            if (!receipt) continue;
            for (const waiter of [...waiters]) {
                if (waiter.waitId !== waitId) continue;
                clearTimeout(waiter.timer);
                waiters.delete(waiter);
                waiter.resolve({ receipt, outcome: 'canceled' });
                canceled = true;
            }
            if (waiters.size === 0) this.waiters.delete(dispatchId);
        }
        return canceled;
    }

    observeTerminalState(terminalId: string, state: ProcessState): void {
        for (const { receipt } of this.options.database.agentDispatchesForTerminal(terminalId)) {
            if (settled(receipt)) continue;
            if (state === 'starting') {
                if (receipt.status === 'running')
                    this.update(receipt.dispatchId, { status: 'interrupted' });
                continue;
            }
            if (state === 'stopped') this.update(receipt.dispatchId, { status: 'stopped' });
            else if (state === 'interrupted')
                this.update(receipt.dispatchId, { status: 'interrupted' });
            else if (state === 'dead' || state === 'failed')
                this.update(receipt.dispatchId, {
                    status: 'failed',
                    failure: { code: 'UNAVAILABLE', reason: 'process_failed' },
                });
        }
    }

    close(): void {
        for (const [dispatchId, waiters] of this.waiters) {
            const receipt = this.options.database.getAgentDispatch(dispatchId)?.receipt;
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                if (receipt) waiter.resolve({ receipt, outcome: 'canceled' });
            }
        }
        this.waiters.clear();
    }

    private async startOnce(
        dispatchId: string,
        principal: Principal,
        input: AgentDispatchStartParams,
    ): Promise<AgentDispatchReceipt> {
        const fingerprint = dispatchFingerprint(principal, 'start', input);
        const existing = this.existing(dispatchId, fingerprint);
        if (existing) return existing;
        const session = this.targetSession(input.projectId, input.sessionId);
        const ownerProject = this.options.database.getProject(session.projectId);
        if (!ownerProject) throw new CaxriError('NOT_FOUND', 'Project not found');
        const launch = this.options.launchSettings(input.provider);
        const projected = launchProjection(input.provider, launch, 'fresh');
        const cwd = await this.options.terminalWorkingDirectory(ownerProject.rootPath);
        const identity = await this.options.terminalDirectoryIdentity(cwd);
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
        this.publish(stored.receipt);
        try {
            this.options.emit({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'terminal.create' },
            });
            this.options.coordinator.prepareTerminalStart(terminal.id);
        } catch (error) {
            return this.fail(dispatchId, error, 'launch_failed');
        }
        return this.launch(dispatchId, terminal, identity);
    }

    private async resumeOnce(
        dispatchId: string,
        principal: Principal,
        input: AgentDispatchResumeParams,
        operation: 'resume' | 'wake',
        requestFingerprint?: string,
    ): Promise<AgentDispatchReceipt> {
        const fingerprint = requestFingerprint ?? dispatchFingerprint(principal, operation, input);
        const existing = this.existing(dispatchId, fingerprint);
        if (existing) return existing;
        const terminal = this.targetTerminal(input);
        if (!terminal.provider || terminal.kind === 'shell')
            throw new CaxriError('CONFLICT', 'Dispatch resume requires an Agent Terminal');
        if (terminal.agentSessionId !== input.providerSessionId)
            throw new CaxriError('UNAVAILABLE', 'Provider session binding changed');
        if (
            terminal.lastProcessState === 'running' ||
            this.options.terminals.processId(terminal.id) !== undefined
        )
            throw new CaxriError('CONFLICT', 'Agent Terminal is already running');
        const launch = this.options.launchSettings(terminal.provider);
        const resumeArgs = agentProviderCatalog[terminal.provider].resumeArguments(
            input.providerSessionId,
        );
        const requested = launchProjection(terminal.provider, launch, 'resume');
        const effective = launchProjection(terminal.provider, launch, 'resume', resumeArgs.length);
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
        this.publish(stored.receipt);
        this.update(dispatchId, { status: 'starting', terminalId: terminal.id });
        let identity: TerminalWorkingDirectoryIdentity;
        try {
            identity = await this.options.terminalDirectoryIdentity(terminal.cwd);
            this.options.coordinator.prepareTerminalResume(terminal.id);
        } catch (error) {
            return this.fail(dispatchId, error, 'launch_failed');
        }
        return this.launch(dispatchId, terminal, identity, input.providerSessionId);
    }

    private async launch(
        dispatchId: string,
        terminal: TerminalRecord,
        expectedWorkingDirectory: TerminalWorkingDirectoryIdentity,
        resumeAgentSessionId?: string,
    ): Promise<AgentDispatchReceipt> {
        try {
            const running = resumeAgentSessionId
                ? await this.options.terminals.restart(terminal.id, {
                      expectedWorkingDirectory,
                      resumeAgentSessionId,
                  })
                : await this.options.terminals.start(terminal, { expectedWorkingDirectory });
            if (
                running.lastProcessState !== 'running' ||
                this.options.terminals.processId(terminal.id) === undefined
            )
                throw new CaxriError('UNAVAILABLE', 'Agent PTY did not become running');
            const endpoint = this.options.endpoints?.endpointForTerminal(terminal.id)?.ref;
            if (!endpoint) {
                const processId = this.options.terminals.processId(terminal.id);
                if (processId !== undefined)
                    this.options.terminals.signalExact(terminal.id, processId, 'SIGHUP');
                throw new CaxriError('UNAVAILABLE', 'Agent Endpoint did not become active');
            }
            const receipt = this.update(dispatchId, {
                status: 'running',
                terminalId: terminal.id,
                endpoint,
            });
            this.options.coordinator.probeTerminal(terminal.id);
            this.options.emit({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: [terminal.id] },
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
        if (session.archivedAt !== undefined)
            throw new CaxriError('CONFLICT', 'Restore the archived Session before dispatching');
        return session;
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
        return terminal;
    }

    private fail(dispatchId: string, error: unknown, reason: DispatchReason): AgentDispatchReceipt {
        const wire = toWireError(error);
        return this.update(dispatchId, {
            status: 'failed',
            failure: { code: wire.code, reason },
        });
    }

    private update(
        dispatchId: string,
        patch: {
            status: AgentDispatchReceipt['status'];
            terminalId?: string;
            endpoint?: AgentEndpointRef;
            failure?: AgentDispatchFailure;
        },
    ): AgentDispatchReceipt {
        const stored = this.options.database.updateAgentDispatch(dispatchId, {
            ...patch,
            now: this.now(),
        });
        this.publish(stored.receipt);
        return stored.receipt;
    }

    private publish(receipt: AgentDispatchReceipt): void {
        this.options.emit({ event: 'agent.dispatch.changed', payload: receipt });
        const waiters = this.waiters.get(receipt.dispatchId);
        if (!waiters) return;
        for (const waiter of [...waiters]) {
            if (receipt.revision <= waiter.afterRevision && !settled(receipt)) continue;
            clearTimeout(waiter.timer);
            waiters.delete(waiter);
            waiter.resolve({ receipt, outcome: 'changed' });
        }
        if (waiters.size === 0) this.waiters.delete(receipt.dispatchId);
    }
}
