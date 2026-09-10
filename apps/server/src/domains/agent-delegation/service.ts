import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type {
    AgentDelegationAnswer,
    AgentDelegationCreate,
    AgentDelegationReceipt,
    AgentLaunchSettings,
    AgentTranscript,
    Principal,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentDispatchService } from '../agent-dispatch';
import type { AgentLifecycleSignal } from '../agents';
/**
 * Provider transcript extraction stays behind the agents domain's public API.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { extractClaudeDelegationAnswer } from '../agents';
import type { CaxriDatabase, StoredAgentDelegation } from '../db';
import { SingleFlight } from '../single-flight';
import { prepareDelegationLaunch, validateDelegationLaunch } from './launch';
import { assertDelegationLayout, delegationLayout } from './layout';
import { applyDelegationLifecycle, isDelegationActive } from './lifecycle';

interface DelegationAuthority {
    principal: Principal;
    callerTerminalId?: string;
}

interface AgentDelegationServiceOptions {
    database: CaxriDatabase;
    dispatch: Pick<AgentDispatchService, 'start'>;
    userDataPath: string;
    launchSettings(): AgentLaunchSettings;
    verifyLaunch(launch: AgentLaunchSettings): Promise<void>;
    readTranscript(terminalId: string): Promise<AgentTranscript | null>;
    dimensions?(terminalId: string): { cols: number; rows: number } | undefined;
    now?: () => number;
}

/**
 * Owns durable task identity and private answers, separate from Terminal lifecycle receipts.
 */
export class AgentDelegationService {
    private readonly requests = new SingleFlight<string, AgentDelegationReceipt>();
    private readonly now: () => number;
    private readonly collectors = new Map<string, NodeJS.Timeout>();
    private readonly activeTerminals = new Map<string, string>();
    private readonly nextCollections = new Map<string, number>();
    private readonly collections = new SingleFlight<
        string,
        {
            receipt: AgentDelegationReceipt;
            answer?: AgentDelegationAnswer;
        }
    >();
    private isClosed = false;
    private waiterCount = 0;

    constructor(private readonly options: AgentDelegationServiceOptions) {
        this.now = options.now ?? Date.now;
    }

    private save(record: StoredAgentDelegation): StoredAgentDelegation {
        const saved = this.options.database.agentDelegations.save({
            ...record,
            receipt: {
                ...record.receipt,
                revision: record.receipt.revision + 1,
                updatedAt: this.now(),
            },
        });
        const { delegationId, terminalId } = saved.receipt;
        if (terminalId) {
            if (isDelegationActive(saved.receipt))
                this.activeTerminals.set(terminalId, delegationId);
            else if (this.activeTerminals.get(terminalId) === delegationId)
                this.activeTerminals.delete(terminalId);
        }
        if (!isDelegationActive(saved.receipt)) this.nextCollections.delete(delegationId);
        return saved;
    }

    private activeForTerminal(terminalId: string): StoredAgentDelegation | undefined {
        const id = this.activeTerminals.get(terminalId);
        if (!id) return;
        const record = this.options.database.agentDelegations.get(id);
        if (record && isDelegationActive(record.receipt)) return record;
        this.activeTerminals.delete(terminalId);
        return undefined;
    }

    private authorize(authority: DelegationAuthority, input: AgentDelegationCreate): void {
        const session = this.options.database.getSession(input.sessionId);
        if (!session || session.projectId !== input.projectId)
            throw new CaxriError('NOT_FOUND', 'Delegation Session is unavailable');
        if (authority.principal.kind === 'human-cli' || authority.principal.kind === 'desktop')
            return;
        if (
            authority.principal.kind !== 'agent' ||
            !authority.principal.projectIds.includes(input.projectId)
        )
            throw new CaxriError('FORBIDDEN', 'Delegation requires an authorized Agent or owner');
        const caller =
            authority.callerTerminalId &&
            this.options.database.getTerminal(authority.callerTerminalId);
        if (!caller || caller.sessionId !== input.sessionId)
            throw new CaxriError('FORBIDDEN', 'Delegation must remain in the caller Session');
    }

    private owned(id: string, authority: DelegationAuthority): StoredAgentDelegation {
        const record = this.options.database.agentDelegations.get(id);
        if (!record) throw new CaxriError('NOT_FOUND', 'Delegation is unavailable');
        this.authorize(authority, record.input);
        if (
            authority.principal.kind === 'agent' &&
            (JSON.stringify(authority.principal) !== JSON.stringify(record.principal) ||
                authority.callerTerminalId !== record.receipt.callerTerminalId)
        )
            throw new CaxriError('FORBIDDEN', 'Delegation belongs to another Agent');
        return record;
    }

    private fail(id: string, failure: AgentDelegationReceipt['failure']): void {
        const record = this.options.database.agentDelegations.get(id);
        if (
            record &&
            (isDelegationActive(record.receipt) ||
                (failure === 'launch_failed' &&
                    !record.turnId &&
                    record.receipt.status === 'interrupted'))
        )
            this.save({ ...record, receipt: { ...record.receipt, status: 'failed', failure } });
    }

    private scheduleCollection(record: StoredAgentDelegation): void {
        const id = record.receipt.delegationId;
        if (this.isClosed || this.collectors.has(id)) return;
        const timer = setTimeout(async () => {
            this.collectors.delete(id);
            try {
                const result = await this.result(id, {
                    principal: record.principal,
                    callerTerminalId: record.receipt.callerTerminalId,
                });
                if (result.receipt.status === 'collecting') this.scheduleCollection(record);
            } catch {
                // Session deletion or shutdown ends ownership; never copy provider content into diagnostics.
                if (!this.isClosed) this.fail(id, 'result_missing');
            }
        }, 200);
        timer.unref();
        this.collectors.set(id, timer);
    }

    private async collectResult(id: string, authority: DelegationAuthority) {
        let record = this.owned(id, authority);
        if (
            record.receipt.status === 'collecting' &&
            record.receipt.terminalId &&
            record.responseDigest &&
            record.providerSessionId
        ) {
            const transcript = await this.options.readTranscript(record.receipt.terminalId);
            if (this.isClosed) return { receipt: record.receipt, answer: record.answer };
            const current = this.owned(id, authority);
            // Human input, restart or another collector may have invalidated this asynchronous read.
            if (current.receipt.revision !== record.receipt.revision)
                return { receipt: current.receipt, answer: current.answer };
            const answer =
                transcript?.content &&
                extractClaudeDelegationAnswer(transcript.content, {
                    sessionId: record.providerSessionId,
                    promptDigest: record.promptDigest,
                    answerDigest: record.responseDigest,
                });
            if (answer) {
                const byteLength = Buffer.byteLength(answer.text);
                record =
                    byteLength > 65_536
                        ? this.save({
                              ...record,
                              receipt: {
                                  ...record.receipt,
                                  status: 'answer_unavailable',
                                  failure: 'payload_overflow',
                              },
                          })
                        : this.save({
                              ...record,
                              receipt: {
                                  ...record.receipt,
                                  status: 'completed',
                                  failure: undefined,
                              },
                              answer: {
                                  ...answer,
                                  byteLength,
                                  source: 'transcript',
                                  truncated: false,
                              },
                          });
            } else if (this.now() - record.receipt.updatedAt > 15_000)
                record = this.save({
                    ...record,
                    receipt: {
                        ...record.receipt,
                        status: 'answer_unavailable',
                        failure: 'result_missing',
                    },
                });
        }
        return { receipt: record.receipt, answer: record.answer };
    }

    async create(
        id: string,
        authority: DelegationAuthority,
        input: AgentDelegationCreate,
    ): Promise<AgentDelegationReceipt> {
        this.authorize(authority, input);
        const fingerprint = createHash('sha256')
            .update(JSON.stringify({ authority, input }))
            .digest('hex');
        const receipt = await this.requests.run(id, async () => {
            const existing = this.options.database.agentDelegations.get(id);
            if (existing) {
                this.owned(id, authority);
                if (existing.fingerprint !== fingerprint)
                    throw new CaxriError(
                        'CONFLICT',
                        'Delegation request was already used for another task',
                    );
                return existing.receipt;
            }
            const frozenLaunch = structuredClone(this.options.launchSettings());
            validateDelegationLaunch(frozenLaunch);
            await this.options.verifyLaunch(frozenLaunch);
            const now = this.now();
            let record = this.options.database.agentDelegations.insert({
                receipt: {
                    delegationId: id,
                    projectId: input.projectId,
                    sessionId: input.sessionId,
                    callerTerminalId: authority.callerTerminalId,
                    provider: input.provider,
                    status: 'requested',
                    revision: 1,
                    createdAt: now,
                    updatedAt: now,
                },
                principal: authority.principal,
                input,
                fingerprint,
                frozenLaunch,
                providerSessionId: randomUUID(),
                promptDigest: '',
            });
            try {
                const prepared = await prepareDelegationLaunch(
                    this.options.userDataPath,
                    id,
                    record.providerSessionId!,
                    input.prompt,
                    frozenLaunch,
                );
                record = this.save({
                    ...record,
                    promptDigest: prepared.promptDigest,
                    receipt: { ...record.receipt, status: 'launching' },
                });
                const dispatched = await this.options.dispatch.start(
                    id,
                    authority.principal,
                    {
                        projectId: input.projectId,
                        sessionId: input.sessionId,
                        provider: input.provider,
                    },
                    {
                        launch: prepared.launch,
                        beforeCreate: () =>
                            assertDelegationLayout(
                                this.options.database.getSessionState(input.sessionId).paneLayout,
                                authority.callerTerminalId,
                            ),
                        cwd: authority.callerTerminalId
                            ? this.options.database.getTerminal(authority.callerTerminalId)?.cwd
                            : undefined,
                        prepared: (terminal) => {
                            record = this.save({
                                ...record,
                                receipt: { ...record.receipt, terminalId: terminal.id },
                            });
                            const state = this.options.database.getSessionState(input.sessionId);
                            this.options.database.updateSessionState({
                                ...state,
                                paneLayout: delegationLayout(
                                    state.paneLayout,
                                    terminal.id,
                                    authority.callerTerminalId,
                                    authority.callerTerminalId
                                        ? this.options.dimensions?.(authority.callerTerminalId)
                                        : undefined,
                                ),
                            });
                        },
                    },
                );
                if (dispatched.status === 'failed') this.fail(id, 'launch_failed');
            } catch {
                this.fail(id, 'launch_failed');
            }
            return this.owned(id, authority).receipt;
        });
        if (this.owned(id, authority).fingerprint !== fingerprint)
            throw new CaxriError(
                'CONFLICT',
                'Delegation request was already used for another task',
            );
        return receipt;
    }

    bindLaunch(terminalId: string, launchId: string): boolean {
        const record = this.activeForTerminal(terminalId);
        if (!record || record.launchId) return false;
        this.save({
            ...record,
            launchId,
            receipt: { ...record.receipt, status: 'awaiting_ready' },
        });
        return true;
    }

    bindEnvironment(terminalId: string, launchId: string, environment: NodeJS.ProcessEnv): void {
        if (!this.bindLaunch(terminalId, launchId)) return;
        if (!environment.CAXRI_HOOK_TOKEN)
            throw new CaxriError(
                'UNAVAILABLE',
                'Visible delegation requires active lifecycle hooks',
            );
        environment.CAXRI_HOOK_DIGEST = '1';
    }

    observe(signal: AgentLifecycleSignal): void {
        const record = this.activeForTerminal(signal.terminalId);
        if (!record) return;
        const next = applyDelegationLifecycle(record, signal);
        if (next) {
            const saved = this.save(next);
            if (saved.receipt.status === 'collecting') this.scheduleCollection(saved);
        }
    }

    status(id: string, authority: DelegationAuthority): AgentDelegationReceipt {
        return this.owned(id, authority).receipt;
    }

    initialize(): void {
        for (const record of this.options.database.agentDelegations.active())
            this.save({
                ...record,
                receipt: { ...record.receipt, status: 'interrupted', failure: 'host_reset' },
            });
    }

    close(): void {
        this.isClosed = true;
        for (const timer of this.collectors.values()) clearTimeout(timer);
        this.collectors.clear();
        this.activeTerminals.clear();
        this.nextCollections.clear();
    }

    async wait(
        id: string,
        authority: DelegationAuthority,
        timeoutMs: number,
        signal?: AbortSignal,
    ) {
        if (this.waiterCount >= 64) throw new CaxriError('CAPACITY', 'Too many delegation waiters');
        this.waiterCount++;
        const deadline = performance.now() + timeoutMs;
        try {
            while (!this.isClosed) {
                // eslint-disable-next-line no-await-in-loop -- each read observes the previous wait's newer durable state
                const result = await this.result(id, authority);
                if (!isDelegationActive(result.receipt))
                    return { ...result, outcome: 'settled' as const };
                if (result.receipt.status === 'blocked')
                    return { ...result, outcome: 'blocked' as const };
                const remaining = deadline - performance.now();
                if (remaining <= 0) return { ...result, outcome: 'timeout' as const };
                // eslint-disable-next-line no-await-in-loop -- bounded long polling must never issue concurrent reads
                await delay(Math.min(200, remaining), undefined, { signal });
            }
            throw new CaxriError('UNAVAILABLE', 'Delegation service is closed');
        } finally {
            this.waiterCount--;
        }
    }

    interruptTerminal(terminalId: string, isHumanInput = false): void {
        const record = this.activeForTerminal(terminalId);
        if (!record) return;
        this.save({
            ...record,
            receipt: {
                ...record.receipt,
                status: isHumanInput ? 'human_intervened' : 'interrupted',
                failure: isHumanInput ? 'human_input' : 'target_changed',
            },
        });
    }

    async result(id: string, authority: DelegationAuthority) {
        const record = this.owned(id, authority);
        if (
            record.receipt.status !== 'collecting' ||
            performance.now() < (this.nextCollections.get(id) ?? 0)
        )
            return { receipt: record.receipt, answer: record.answer };
        return this.collections.run(id, () => {
            // Many waiters share one bounded transcript read per poll interval.
            this.nextCollections.set(id, performance.now() + 200);
            return this.collectResult(id, authority);
        });
    }
}
