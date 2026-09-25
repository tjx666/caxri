import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type {
    AgentDelegationAnswer,
    AgentDelegationCreate,
    AgentDelegationReceipt,
} from '@caxri/protocol';
import { agentDelegationSettingsSchema, CaxriError } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';
/**
 * Provider transcript extraction stays behind the agents domain's public API.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { delegationAdapter } from '../agents';
import type { StoredAgentDelegation } from '../db';
import { SingleFlight } from '../single-flight';
import type { DelegationAuthority } from './admission';
import {
    authorizeDelegationSession,
    delegationCaller,
    delegationRoster,
    resolveDelegationAdmission,
} from './admission';
import { readDelegationCompletion } from './collection';
import { prepareDelegationFollowUp, prepareDelegationLaunch } from './launch';
import { assertDelegationLayout, delegationLayout } from './layout';
import { applyDelegationLifecycle, isDelegationActive } from './lifecycle';
import type { DelegationFollowUpRejection, DelegationResumeRejection } from './rejection';
import { reportFollowUpRejection, reportResumeRejection } from './rejection';
import { applyDelegationCompletion, shouldCollectDelegation } from './result';
import type { AgentDelegationServiceOptions } from './service-options';
import { removeDelegationFiles } from './storage';

/**
 * Owns durable task identity and private answers, separate from Terminal lifecycle receipts.
 */
export class AgentDelegationService {
    private readonly requests = new SingleFlight<string, AgentDelegationReceipt>();
    private readonly now: () => number;
    private readonly collectors = new Map<string, NodeJS.Timeout>();
    private readonly submissionTimers = new Map<string, NodeJS.Timeout>();
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
    private readonly deletingSessions = new Set<string>();
    private readonly pendingCreations = new Map<string, Set<Promise<AgentDelegationReceipt>>>();
    private readonly humanIntervenedTerminals = new Set<string>();

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

    private authorize(
        authority: DelegationAuthority,
        input: Pick<AgentDelegationCreate, 'projectId' | 'sessionId'>,
    ): void {
        if (this.deletingSessions.has(input.sessionId))
            throw new CaxriError('CONFLICT', 'Delegation Session is being deleted');
        authorizeDelegationSession(this.options.database, authority, input);
    }

    private owned(id: string, authority: DelegationAuthority): StoredAgentDelegation {
        const record = this.options.database.agentDelegations.get(id);
        if (!record) throw new CaxriError('NOT_FOUND', 'Delegation is unavailable');
        this.authorize(authority, record.input);
        if (
            (authority.principal.kind === 'agent' ||
                authority.principal.kind === 'delegation-client') &&
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
                    record.receipt.failure === 'target_changed' &&
                    record.receipt.status === 'interrupted'))
        )
            this.save({ ...record, receipt: { ...record.receipt, status: 'failed', failure } });
    }

    /**
     * Applies the Terminal Host's real answer for a follow-up whose prompt was admitted before it was delivered.
     *
     * A background delegation writes to a Terminal with no Renderer attachment, so the Host can still refuse the input
     * — the launch changed while it was waiting, or the request was rejected outright. Reported as success, the task
     * sat in `submitting` until its 15s timeout turned it into `submission_unconfirmed`, which names the wrong cause.
     * Only a task still waiting for that prompt is settled; anything else already has an outcome of its own.
     */
    private settleSubmission(id: string, wasDelivered: boolean): void {
        if (wasDelivered) return;
        if (this.options.database.agentDelegations.get(id)?.receipt.status !== 'submitting') return;
        clearTimeout(this.submissionTimers.get(id));
        this.submissionTimers.delete(id);
        this.fail(id, 'target_changed');
    }

    /**
     * Corrects a Stop that reported `caller_stopped` before the Terminal Host refused its Esc. The task is interrupted
     * either way; what changes is whether the Agent was actually told to stop.
     */
    private settleStop(id: string, wasDelivered: boolean): void {
        if (wasDelivered) return;
        const record = this.options.database.agentDelegations.get(id);
        if (record?.receipt.status !== 'interrupted' || record.receipt.failure !== 'caller_stopped')
            return;
        this.save({
            ...record,
            receipt: { ...record.receipt, failure: 'target_changed' },
        });
    }

    private scheduleCollection(record: StoredAgentDelegation): void {
        const id = record.receipt.delegationId;
        if (this.isClosed || this.collectors.has(id)) return;
        const timer = setTimeout(
            async () => {
                this.collectors.delete(id);
                try {
                    const result = await this.result(id, {
                        principal: record.principal,
                        callerTerminalId: record.receipt.callerTerminalId,
                    });
                    if (isDelegationActive(result.receipt)) this.scheduleCollection(record);
                } catch {
                    // Session deletion or shutdown ends ownership; never copy provider content into diagnostics.
                    if (!this.isClosed) this.fail(id, 'result_missing');
                }
            },
            delegationAdapter(record.receipt.provider).completion === 'native-completion'
                ? 2_000
                : 200,
        );
        timer.unref();
        this.collectors.set(id, timer);
    }

    private async collectResult(id: string, authority: DelegationAuthority) {
        let record = this.owned(id, authority);
        if (
            shouldCollectDelegation(record) &&
            record.receipt.terminalId &&
            record.providerSessionId
        ) {
            const { completion, batch } = await readDelegationCompletion(record, this.options);
            if (this.isClosed) return { receipt: record.receipt, answer: record.answer };
            const current = this.owned(id, authority);
            // Human input, restart or another collector may have invalidated this asynchronous read.
            if (current.receipt.revision !== record.receipt.revision)
                return { receipt: current.receipt, answer: current.answer };
            const next = applyDelegationCompletion(
                record,
                completion,
                this.now(),
                batch?.isFinished,
            );
            if (next || (batch?.offset !== undefined && batch.offset !== record.transcriptOffset))
                record = this.save({
                    ...(next ?? record),
                    transcriptOffset: batch?.offset ?? record.transcriptOffset,
                });
        }
        return { receipt: record.receipt, answer: record.answer };
    }

    private async resumeTask(
        record: StoredAgentDelegation,
        authority: DelegationAuthority,
        previous: StoredAgentDelegation,
    ): Promise<AgentDelegationReceipt> {
        const id = record.receipt.delegationId;
        const prepared = await prepareDelegationFollowUp(
            this.options.userDataPath,
            record.rootDelegationId!,
            id,
            [record.frozenInstructions, record.input.prompt].filter(Boolean).join('\n\n'),
        );
        const parent = this.owned(previous.receipt.delegationId, authority);
        const reject = (reason: DelegationResumeRejection) => {
            this.fail(id, reportResumeRejection(this.options.logger, id, reason));
            return this.owned(id, authority).receipt;
        };
        if (!isDelegationActive(this.owned(id, authority).receipt))
            return this.owned(id, authority).receipt;
        const terminalId = parent.receipt.terminalId;
        if (!terminalId) return reject('no_terminal');
        if (!parent.providerSessionId) return reject('no_provider_session');
        if (
            this.options.database.getTerminal(terminalId)?.agentSessionId !==
            parent.providerSessionId
        )
            return reject('provider_session_replaced');
        if (parent.nextDelegationId) return reject('parent_chained');
        if (this.activeForTerminal(terminalId)) return reject('terminal_busy');
        if (parent.hasLostTarget) return reject('target_lost');
        const expectedLaunchId = this.options.currentLaunchId?.(terminalId);
        if (expectedLaunchId && expectedLaunchId !== parent.launchId)
            return reject('launch_replaced');
        if (parent.hasHumanIntervention) return reject('human_intervened');
        if (parent.inputEpoch === undefined) return reject('no_input_epoch');
        if (this.options.inputEpoch?.(terminalId) !== parent.inputEpoch)
            return reject('input_epoch_moved');
        if (
            parent.receipt.status === 'human_intervened' ||
            parent.receipt.failure === 'human_input'
        )
            return reject('parent_human_intervened');
        if (!this.options.dispatch.resume) return reject('resume_unsupported');
        this.save({ ...parent, nextDelegationId: id });
        this.save({
            ...record,
            promptDigest: prepared.promptDigest,
            inputEpoch: parent.inputEpoch,
            receipt: { ...record.receipt, terminalId, status: 'launching' },
        });
        const shouldStart = () => {
            const current = this.options.database.agentDelegations.get(id);
            return (
                current !== undefined &&
                isDelegationActive(current.receipt) &&
                !this.deletingSessions.has(record.input.sessionId) &&
                this.options.inputEpoch?.(terminalId) === parent.inputEpoch
            );
        };
        const dispatched = await this.options.dispatch.resume(
            id,
            authority.principal,
            {
                projectId: record.input.projectId,
                sessionId: record.input.sessionId,
                terminalId,
                providerSessionId: parent.providerSessionId,
            },
            {
                delegationId: id,
                launch:
                    delegationAdapter(record.receipt.provider).resumeLaunch?.(
                        record.frozenLaunch,
                        join(this.options.userDataPath, 'delegations', record.rootDelegationId!),
                    ) ?? record.frozenLaunch,
                initialPrompt: prepared.pointer,
                replaceLaunchId: expectedLaunchId,
                shouldStart,
                beforeResume: () => {
                    if (
                        !shouldStart() ||
                        this.options.currentLaunchId?.(terminalId) !== expectedLaunchId
                    )
                        throw new CaxriError(
                            'CONFLICT',
                            'Delegation ownership changed before exact resume',
                        );
                },
            },
        );
        if (dispatched.status === 'failed') this.fail(id, 'launch_failed');
        return this.owned(id, authority).receipt;
    }

    private async followUp(
        record: StoredAgentDelegation,
        authority: DelegationAuthority,
        previous: StoredAgentDelegation,
    ): Promise<AgentDelegationReceipt> {
        const id = record.receipt.delegationId;
        const prepared = await prepareDelegationFollowUp(
            this.options.userDataPath,
            record.rootDelegationId!,
            id,
            [record.frozenInstructions, record.input.prompt].filter(Boolean).join('\n\n'),
        );
        const current = this.owned(id, authority);
        if (!isDelegationActive(current.receipt)) return current.receipt;
        const parent = this.owned(previous.receipt.delegationId, authority);
        const terminalId = parent.receipt.terminalId;
        const reject = (reason: DelegationFollowUpRejection) => {
            this.fail(id, reportFollowUpRejection(this.options.logger, id, reason));
            return this.owned(id, authority).receipt;
        };
        if (parent.nextDelegationId) return reject('parent_chained');
        if (terminalId && this.activeForTerminal(terminalId)) return reject('terminal_busy');
        if (!terminalId) return reject('no_terminal');
        if (parent.hasLostTarget) return reject('target_lost');
        if (!parent.launchId) return reject('no_launch');
        if (!parent.providerSessionId) return reject('no_provider_session');
        if (this.options.currentLaunchId?.(terminalId) !== parent.launchId)
            return reject('launch_replaced');
        if (parent.hasHumanIntervention) return reject('human_intervened');
        if (parent.inputEpoch === undefined) return reject('no_input_epoch');
        if (this.options.inputEpoch?.(terminalId) !== parent.inputEpoch)
            return reject('input_epoch_moved');
        if (!parent.turnId) return reject('no_turn');
        if (!this.options.isIdle?.(terminalId, parent.launchId, parent.turnId))
            return reject('target_not_idle');
        /**
         * No await may split admission, the durable chain claim and exact-generation write. Human input must either
         * invalidate the preceding epoch or arrive after the new task owns the Terminal.
         */
        this.save({ ...parent, nextDelegationId: id });
        this.save({
            ...record,
            launchId: parent.launchId,
            inputEpoch: parent.inputEpoch,
            promptDigest: prepared.promptDigest,
            receipt: { ...record.receipt, terminalId, status: 'submitting' },
        });
        if (
            !this.options.write?.(
                terminalId,
                parent.launchId,
                `\u{1B}[200~${prepared.pointer}\u{1B}[201~\r`,
                (wasDelivered) => this.settleSubmission(id, wasDelivered),
            )
        )
            return reject('write_refused');
        if (this.options.database.agentDelegations.get(id)?.receipt.status === 'submitting') {
            const timer = setTimeout(() => {
                this.submissionTimers.delete(id);
                if (this.options.database.agentDelegations.get(id)?.receipt.status === 'submitting')
                    this.fail(id, 'submission_unconfirmed');
            }, this.options.submissionTimeoutMs ?? 15_000);
            timer.unref();
            this.submissionTimers.set(id, timer);
        }
        return this.owned(id, authority).receipt;
    }

    presets(
        authority: DelegationAuthority,
        input: Pick<AgentDelegationCreate, 'projectId' | 'sessionId' | 'callerProvider'>,
    ) {
        this.authorize(authority, input);
        return delegationRoster(
            this.options.delegationSettings?.() ?? agentDelegationSettingsSchema.parse({}),
            delegationCaller(this.options.database, authority, input.callerProvider),
        );
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
        const pending = this.requests.run(id, async () => {
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
            const previousId = input.followUpOf ?? input.resumeFrom;
            if (authority.principal.kind === 'delegation-client') {
                const active = this.options.database.agentDelegations
                    .active()
                    .filter((record) => record.input.sessionId === input.sessionId).length;
                if (active + (this.pendingCreations.get(input.sessionId)?.size ?? 0) >= 4)
                    throw new CaxriError(
                        'CAPACITY',
                        'External delegation Session already has four active or pending tasks',
                    );
            }
            const previous = previousId ? this.owned(previousId, authority) : undefined;
            const config = resolveDelegationAdmission({
                ...this.options,
                authority,
                input,
                previous,
                settings:
                    this.options.delegationSettings?.() ?? agentDelegationSettingsSchema.parse({}),
            });
            const { frozenLaunch, selection, frozenInstructions, depth, parentDelegationId } =
                config;
            const provider = selection.provider;
            if (!previous || input.resumeFrom)
                await this.options.verifyLaunch(frozenLaunch, provider);
            const now = this.now();
            let record = this.options.database.agentDelegations.insert({
                receipt: {
                    delegationId: id,
                    projectId: input.projectId,
                    sessionId: input.sessionId,
                    callerTerminalId: authority.callerTerminalId,
                    followUpOf: input.followUpOf,
                    resumeFrom: input.resumeFrom,
                    provider,
                    selection,
                    depth,
                    parentDelegationId,
                    status: 'requested',
                    revision: 1,
                    createdAt: now,
                    updatedAt: now,
                },
                principal: authority.principal,
                input,
                fingerprint,
                frozenLaunch,
                frozenInstructions,
                providerSessionId:
                    previous?.providerSessionId ?? delegationAdapter(provider).createSessionId(),
                transcriptOffset: previous?.transcriptOffset,
                rootDelegationId:
                    previous?.rootDelegationId ?? previous?.receipt.delegationId ?? id,
                promptDigest: '',
            });
            try {
                if (previous)
                    return await (input.resumeFrom
                        ? this.resumeTask(record, authority, previous)
                        : this.followUp(record, authority, previous));
                const prepared = await prepareDelegationLaunch(
                    this.options.userDataPath,
                    id,
                    provider,
                    record.providerSessionId,
                    [frozenInstructions, input.prompt].filter(Boolean).join('\n\n'),
                    frozenLaunch,
                );
                record = this.owned(id, authority);
                if (!isDelegationActive(record.receipt)) return record.receipt;
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
                        provider,
                    },
                    {
                        delegationId: id,
                        launch: prepared.launch,
                        initialPrompt: prepared.initialPrompt,
                        assignedAgentSessionId: prepared.assignedAgentSessionId,
                        shouldStart: () => {
                            const current = this.options.database.agentDelegations.get(id);
                            return (
                                current !== undefined &&
                                isDelegationActive(current.receipt) &&
                                !this.deletingSessions.has(input.sessionId)
                            );
                        },
                        beforeCreate: () => {
                            if (!isDelegationActive(this.owned(id, authority).receipt))
                                throw new CaxriError(
                                    'CANCELLED',
                                    'Delegation was stopped before launch',
                                );
                            assertDelegationLayout(
                                this.options.database.getSessionState(input.sessionId).paneLayout,
                                authority.callerTerminalId,
                            );
                        },
                        cwd: authority.callerTerminalId
                            ? this.options.database.getTerminal(authority.callerTerminalId)?.cwd
                            : undefined,
                        prepared: (terminal) => {
                            record = this.owned(id, authority);
                            if (!isDelegationActive(record.receipt))
                                throw new CaxriError(
                                    'CANCELLED',
                                    'Delegation was stopped before launch',
                                );
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
        let creations = this.pendingCreations.get(input.sessionId);
        if (!creations) {
            creations = new Set();
            this.pendingCreations.set(input.sessionId, creations);
        }
        creations.add(pending);
        let receipt: AgentDelegationReceipt;
        try {
            receipt = await pending;
        } finally {
            creations.delete(pending);
            if (creations.size === 0) this.pendingCreations.delete(input.sessionId);
        }
        if (this.owned(id, authority).fingerprint !== fingerprint)
            throw new CaxriError(
                'CONFLICT',
                'Delegation request was already used for another task',
            );
        return receipt;
    }

    /**
     * Fences creation and cleans private files before deleting metadata; failed cleanup retains the records.
     */
    async deleteSessions<T>(ids: readonly string[], remove: () => T | Promise<T>): Promise<T> {
        if (ids.some((id) => this.deletingSessions.has(id)))
            throw new CaxriError('CONFLICT', 'Delegation Session is already being deleted');
        for (const id of ids) this.deletingSessions.add(id);
        try {
            await Promise.allSettled(
                ids.flatMap((id) => [...(this.pendingCreations.get(id) ?? [])]),
            );
            await removeDelegationFiles(
                this.options.userDataPath,
                this.options.database.agentDelegations.storageRootsForSessions(ids),
            );
            return await remove();
        } finally {
            for (const id of ids) this.deletingSessions.delete(id);
        }
    }

    bindLaunch(terminalId: string, launchId: string): boolean {
        const record = this.activeForTerminal(terminalId);
        if (!record || record.launchId) return false;
        this.save({
            ...record,
            launchId,
            inputEpoch: this.options.inputEpoch?.(terminalId),
            receipt: { ...record.receipt, status: 'awaiting_ready' },
        });
        const id = record.receipt.delegationId;
        const timer = setTimeout(() => {
            this.submissionTimers.delete(id);
            const current = this.options.database.agentDelegations.get(id);
            if (current && !current.turnId && isDelegationActive(current.receipt))
                this.fail(id, 'startup_not_ready');
        }, this.options.submissionTimeoutMs ?? 15_000);
        timer.unref();
        this.submissionTimers.set(id, timer);
        return true;
    }

    bindEnvironment(
        terminalId: string,
        launchId: string,
        environment: NodeJS.ProcessEnv,
        delegationId?: string,
    ): void {
        const active = this.activeForTerminal(terminalId);
        if (delegationId && active?.receipt.delegationId !== delegationId)
            throw new CaxriError('CANCELLED', 'Delegation no longer owns this launch');
        if (!delegationId || !this.bindLaunch(terminalId, launchId)) {
            /**
             * Owner-initiated restart can retain the native session without PTY input. Persist the generation fence
             * before that launch so Server restart cannot make the earlier delegation eligible to resume again.
             */
            for (const task of this.options.database.agentDelegations.forTerminal(terminalId))
                if (task.launchId !== launchId && !task.hasLostTarget)
                    this.save({
                        ...task,
                        hasLostTarget: true,
                        receipt: isDelegationActive(task.receipt)
                            ? { ...task.receipt, status: 'interrupted', failure: 'target_changed' }
                            : task.receipt,
                    });
            return;
        }
        if (!environment.CAXRI_HOOK_TOKEN)
            throw new CaxriError(
                'UNAVAILABLE',
                'Visible delegation requires active lifecycle hooks',
            );
        environment.CAXRI_HOOK_DIGEST = '1';
    }

    observe(signal: AgentLifecycleSignal, source: 'lifecycle' | 'evidence' = 'lifecycle'): void {
        const record = this.activeForTerminal(signal.terminalId);
        if (!record) return;
        const next = applyDelegationLifecycle(record, signal, source);
        if (next) {
            const saved = this.save(next);
            if (saved.turnId || !isDelegationActive(saved.receipt)) {
                clearTimeout(this.submissionTimers.get(saved.receipt.delegationId));
                this.submissionTimers.delete(saved.receipt.delegationId);
            }
            if (shouldCollectDelegation(saved)) this.scheduleCollection(saved);
        }
    }

    status(id: string, authority: DelegationAuthority): AgentDelegationReceipt {
        return this.owned(id, authority).receipt;
    }

    stop(id: string, authority: DelegationAuthority): AgentDelegationReceipt {
        const record = this.owned(id, authority);
        if (!isDelegationActive(record.receipt) || record.receipt.status === 'collecting')
            return record.receipt;
        const { terminalId } = record.receipt;
        const accepted =
            !terminalId ||
            !record.launchId ||
            this.options.write?.(terminalId, record.launchId, '\u{1B}', (wasDelivered) =>
                this.settleStop(id, wasDelivered),
            );
        return this.save({
            ...record,
            receipt: {
                ...record.receipt,
                status: 'interrupted',
                failure: accepted ? 'caller_stopped' : 'target_changed',
            },
        }).receipt;
    }

    initialize(): void {
        for (const record of this.options.database.agentDelegations.active()) {
            if (
                ((record.receipt.status === 'collecting' && record.responseDigest) ||
                    (record.turnId &&
                        delegationAdapter(record.receipt.provider).completion ===
                            'native-completion')) &&
                record.providerSessionId
            ) {
                // A retired native process may have persisted completion just before Server restart; never replay it.
                this.scheduleCollection(
                    this.save({ ...record, receipt: { ...record.receipt, status: 'collecting' } }),
                );
                continue;
            }
            this.save({
                ...record,
                receipt: { ...record.receipt, status: 'interrupted', failure: 'host_reset' },
            });
        }
    }

    close(): void {
        this.isClosed = true;
        for (const timer of this.collectors.values()) clearTimeout(timer);
        for (const timer of this.submissionTimers.values()) clearTimeout(timer);
        this.submissionTimers.clear();
        this.collectors.clear();
        this.activeTerminals.clear();
        this.nextCollections.clear();
        this.humanIntervenedTerminals.clear();
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

    interruptTerminal(terminalId: string, isHumanInput = false, retiredLaunchId?: string): void {
        /**
         * A completed answer stays readable, but human takeover permanently revokes its continuation authority. Persist
         * once per Terminal lifetime because the input epoch alone is lost on Server restart.
         */
        if (isHumanInput && !this.humanIntervenedTerminals.has(terminalId)) {
            this.humanIntervenedTerminals.add(terminalId);
            for (const task of this.options.database.agentDelegations.forTerminal(terminalId))
                if (!task.hasHumanIntervention) this.save({ ...task, hasHumanIntervention: true });
        }
        const record = this.activeForTerminal(terminalId);
        if (!record) return;
        if (
            !isHumanInput &&
            record.input.resumeFrom &&
            !record.launchId &&
            record.receipt.status === 'launching'
        )
            return;
        if (
            !isHumanInput &&
            retiredLaunchId &&
            record.launchId &&
            record.launchId !== retiredLaunchId
        )
            return;
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
            !shouldCollectDelegation(record) ||
            performance.now() < (this.nextCollections.get(id) ?? 0)
        )
            return { receipt: record.receipt, answer: record.answer };
        return this.collections.run(id, () => {
            // Many waiters share one bounded transcript read per poll interval.
            this.nextCollections.set(
                id,
                performance.now() +
                    (delegationAdapter(record.receipt.provider).completion === 'native-completion'
                        ? 2_000
                        : 200),
            );
            return this.collectResult(id, authority);
        });
    }
}
