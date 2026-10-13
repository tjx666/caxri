import { createHash } from 'node:crypto';

import type {
    AgentDelegationCreate,
    AgentDelegationCreateRequest,
    AgentDelegationReceipt,
} from '@caxri/protocol';
import { agentDelegationSettingsSchema, CaxriError, isDelegationActive } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';
import type { StoredAgentDelegation } from '../db';
import { SingleFlight } from '../single-flight';
import type { DelegationAccess, DelegationAuthority } from './admission';
import {
    admittedDelegation,
    authorizeDelegationSession,
    delegationCaller,
    delegationPaneCaller,
    delegationRoster,
    isAgentCommanderCaller,
    resolveDelegationAdmission,
} from './admission';
import { delegationChildLaunch } from './chat-child';
import { readDelegationCompletion } from './collection';
import { logDelegationRequested, logDelegationTransition } from './diagnostics';
import { prepareDelegationFollowUp, prepareDelegationLaunch } from './launch';
import { fenceTerminalLaunch } from './launch-fence';
import { assertDelegationLayout, delegationLayout } from './layout';
import {
    applyDelegationLifecycle,
    canFailDelegation,
    isReceiptTransition,
    recoveredDelegation,
} from './lifecycle';
import { admitDelegationRequest } from './new-session';
import { isDelegationOwner, listOwnedDelegations } from './ownership';
import type { DelegationFollowUpRejection } from './rejection';
import { followUpRejection, reportFollowUpRejection } from './rejection';
import { applyDelegationCompletion, collectionIntervalMs, shouldCollectDelegation } from './result';
import type { ExactResumeHost } from './resume';
import { continueHandover, handoverTarget, resumeTask } from './resume';
import type { AgentDelegationServiceOptions } from './service-options';
import { interruptedDelegation, isStartupPromptInput, startupDeadlineOutcome } from './startup';
import { removeDelegationFiles } from './storage';
import { pollDelegations } from './wait';

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
        Pick<StoredAgentDelegation, 'answer' | 'receipt'>
    >();
    private isClosed = false;
    private waiterCount = 0;
    private readonly deletingSessions = new Set<string>();
    private readonly pendingCreations = new Map<string, Set<Promise<AgentDelegationReceipt>>>();
    private readonly humanIntervenedTerminals = new Set<string>();

    constructor(private readonly options: AgentDelegationServiceOptions) {
        this.now = options.now ?? Date.now;
    }

    /**
     * `isAnnounced` is false only for Server restart recovery. Desktop windows reload their state on reconnect and a
     * later `status` or `wait` reads the recovered receipt itself, while one event per recovered task would overflow
     * the bounded queue that holds startup events until the event journal opens, failing Server Core startup.
     */
    private save(record: StoredAgentDelegation, isAnnounced = true): StoredAgentDelegation {
        /**
         * The stored row, not the caller's copy, holds what observers last saw.
         */
        const before = this.options.database.agentDelegations.get(record.receipt.delegationId);
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
        if (isReceiptTransition(before?.receipt, saved.receipt)) {
            logDelegationTransition(
                this.options.logger,
                saved.receipt,
                before?.receipt,
                !isAnnounced,
            );
            if (isAnnounced) this.options.onReceiptChanged?.(saved.receipt, before?.receipt);
        }
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
        access: DelegationAccess,
        isNewSession = false,
    ): void {
        if (this.deletingSessions.has(input.sessionId))
            throw new CaxriError('CONFLICT', 'Delegation Session is being deleted');
        authorizeDelegationSession(this.options.database, authority, input, access, isNewSession);
    }

    private owned(
        id: string,
        authority: DelegationAuthority,
        access: DelegationAccess = 'create',
    ): StoredAgentDelegation {
        const record = this.options.database.agentDelegations.get(id);
        if (!record) throw new CaxriError('NOT_FOUND', 'Delegation is unavailable');
        this.authorize(authority, record.input, access);
        if (!isDelegationOwner(this.options.database, record, authority))
            throw new CaxriError('FORBIDDEN', 'Delegation belongs to another Agent');
        return record;
    }

    private fail(id: string, failure: AgentDelegationReceipt['failure']): void {
        const record = this.options.database.agentDelegations.get(id);
        if (record && canFailDelegation(record, failure))
            this.save({ ...record, receipt: { ...record.receipt, status: 'failed', failure } });
    }

    /**
     * Applies the Terminal Host's real answer for a follow-up whose prompt was admitted before it was delivered.
     *
     * A background delegation writes to a Terminal with no Renderer attachment, so the Host can still refuse the input:
     * the launch changed while it was waiting, or the request was rejected outright. Reported as success, the task sat
     * in `submitting` until its 15s timeout turned it into `submission_unconfirmed`, which names the wrong cause. Only
     * a task still waiting for that prompt is settled; anything else already has an outcome of its own.
     */
    private settleSubmission(id: string, wasDelivered: boolean): void {
        if (wasDelivered) return;
        if (this.options.database.agentDelegations.get(id)?.receipt.status !== 'submitting') return;
        clearTimeout(this.submissionTimers.get(id));
        this.submissionTimers.delete(id);
        this.fail(id, 'target_changed');
    }

    /**
     * Returns a parent's chain claim after the Host refused its follow-up before taking any input, so the task can
     * still be continued. The refused child never joined the conversation and is fenced like a lost target. A refusal
     * the Host reports later keeps the claim: that report also covers a lost acknowledgement, so a retry could submit
     * twice.
     */
    private releaseRefusedFollowUp(id: string, parentId: string): void {
        const { agentDelegations } = this.options.database;
        this.save({ ...agentDelegations.get(id)!, hasLostTarget: true });
        this.save({ ...agentDelegations.get(parentId)!, nextDelegationId: undefined });
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
        const timer = setTimeout(async () => {
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
        }, collectionIntervalMs(record.receipt.provider));
        timer.unref();
        this.collectors.set(id, timer);
    }

    private async collectResult(id: string, authority: DelegationAuthority) {
        let record = this.owned(id, authority, 'existing');
        if (
            shouldCollectDelegation(record) &&
            record.receipt.terminalId &&
            record.providerSessionId
        ) {
            const { completion, batch } = await readDelegationCompletion(record, this.options);
            if (this.isClosed) return { receipt: record.receipt, answer: record.answer };
            const current = this.owned(id, authority, 'existing');
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
        const reject = (reason: DelegationFollowUpRejection) => {
            this.fail(id, reportFollowUpRejection(this.options.logger, id, reason));
            return this.owned(id, authority).receipt;
        };
        const rejection = followUpRejection(parent, this.options, (terminalId) =>
            Boolean(this.activeForTerminal(terminalId)),
        );
        if (rejection) return reject(rejection);
        const terminalId = parent.receipt.terminalId!;
        const launchId = parent.launchId!;
        /**
         * No await may split admission, the durable chain claim and exact-generation write. Human input must either
         * invalidate the preceding epoch or arrive after the new task owns the Terminal.
         */
        this.save({ ...parent, nextDelegationId: id });
        this.save({
            ...record,
            launchId,
            inputEpoch: parent.inputEpoch,
            promptDigest: prepared.promptDigest,
            receipt: { ...record.receipt, terminalId, status: 'submitting' },
        });
        if (
            !this.options.write?.(
                terminalId,
                launchId,
                `\u{1B}[200~${prepared.pointer}\u{1B}[201~\r`,
                (wasDelivered) => this.settleSubmission(id, wasDelivered),
            )
        ) {
            this.releaseRefusedFollowUp(id, parent.receipt.delegationId);
            return reject('write_refused');
        }
        if (this.options.database.agentDelegations.get(id)?.receipt.status === 'submitting')
            this.armSubmissionTimer(id, () => {
                if (this.options.database.agentDelegations.get(id)?.receipt.status === 'submitting')
                    this.fail(id, 'submission_unconfirmed');
            });
        return this.owned(id, authority).receipt;
    }

    private exactResumeHost(authority: DelegationAuthority): ExactResumeHost {
        return {
            hasActiveTask: (terminalId) => Boolean(this.activeForTerminal(terminalId)),
            options: this.options,
            owned: (id) => this.owned(id, authority),
            save: (record) => this.save(record),
            fail: (id, failure) => this.fail(id, failure),
            isDeleting: (sessionId) => this.deletingSessions.has(sessionId),
        };
    }

    /**
     * Settles a launch that has not started its turn by the deadline; see `startupDeadlineOutcome`.
     */
    private armStartupDeadline(id: string, terminalId: string, launchId: string): void {
        this.armSubmissionTimer(id, () => {
            const current = this.options.database.agentDelegations.get(id);
            const isAlive = this.options.currentLaunchId?.(terminalId) === launchId;
            const outcome = current && startupDeadlineOutcome(current, isAlive);
            if (outcome === 'startup_not_ready') this.fail(id, outcome);
            else if (outcome) this.save(outcome);
        });
    }

    private armSubmissionTimer(id: string, onExpired: () => void): void {
        const timer = setTimeout(() => {
            this.submissionTimers.delete(id);
            onExpired();
        }, this.options.submissionTimeoutMs ?? 15_000);
        timer.unref();
        this.submissionTimers.set(id, timer);
    }

    private async createInSession(
        id: string,
        authority: DelegationAuthority,
        input: AgentDelegationCreate,
        isNewSession: boolean,
    ): Promise<AgentDelegationReceipt> {
        this.authorize(authority, input, 'create', isNewSession);
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
            const { continueFromHandover } = input;
            const handover = continueFromHandover
                ? handoverTarget(
                      this.options,
                      authority,
                      { ...input, continueFromHandover },
                      (terminal) => Boolean(this.activeForTerminal(terminal)),
                  )
                : undefined;
            const config = resolveDelegationAdmission({
                ...this.options,
                authority,
                input: handover ? { ...input, provider: handover.provider } : input,
                previous,
                settings:
                    this.options.delegationSettings?.() ?? agentDelegationSettingsSchema.parse({}),
            });
            const { frozenLaunch, frozenInstructions } = config;
            const provider = config.selection.provider;
            if (!previous || input.resumeFrom)
                await this.options.verifyLaunch(frozenLaunch, provider);
            let record = this.options.database.agentDelegations.insert(
                admittedDelegation({
                    id,
                    now: this.now(),
                    authority,
                    input,
                    fingerprint,
                    admission: config,
                    previous,
                    providerSessionId: handover?.providerSessionId,
                }),
            );
            // Before the announcement, so the ledger links the hand-over's task instead of recording a second one.
            if (continueFromHandover)
                this.options.commanderHandovers?.consume(continueFromHandover, id);
            logDelegationRequested(this.options.logger, record.receipt, input, {
                isCommander: isAgentCommanderCaller(this.options.database, authority),
                parentDelegationId: previousId,
                terminalId: authority.callerTerminalId,
            });
            this.options.onReceiptChanged?.(record.receipt);
            try {
                if (handover)
                    return await continueHandover(
                        this.exactResumeHost(authority),
                        record,
                        authority,
                        handover,
                    );
                if (previous)
                    return await (input.resumeFrom
                        ? resumeTask(this.exactResumeHost(authority), record, authority, previous)
                        : this.followUp(record, authority, previous));
                const pane = delegationPaneCaller(this.options.database, authority, input);
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
                        ...delegationChildLaunch(this.options, record, prepared),
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
                                pane?.id,
                            );
                        },
                        cwd: pane?.cwd,
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
                                    pane?.id,
                                    pane && this.options.dimensions?.(pane.id),
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
     * Binds a launch to `delegationId`'s task, returning true, or otherwise fences the Terminal's earlier tasks; see
     * {@link fenceTerminalLaunch}.
     */
    private bindTerminalLaunch(terminalId: string, launchId: string, delegationId?: string) {
        const active = this.activeForTerminal(terminalId);
        if (delegationId && active?.receipt.delegationId !== delegationId)
            throw new CaxriError('CANCELLED', 'Delegation no longer owns this launch');
        if (delegationId && this.bindLaunch(terminalId, launchId)) return true;
        fenceTerminalLaunch(
            {
                database: this.options.database,
                inputEpoch: (id) => this.options.inputEpoch?.(id),
                save: (record) => this.save(record),
            },
            terminalId,
            launchId,
        );
        return false;
    }

    /**
     * The caller's own tasks; see `listOwnedDelegations`.
     */
    list(authority: DelegationAuthority, options: { active: boolean; limit: number }) {
        return listOwnedDelegations(this.options.database, authority, options);
    }

    presets(
        authority: DelegationAuthority,
        input: Pick<AgentDelegationCreate, 'projectId' | 'sessionId' | 'callerProvider'>,
    ) {
        this.authorize(authority, input, 'create');
        return delegationRoster(
            this.options.delegationSettings?.() ?? agentDelegationSettingsSchema.parse({}),
            delegationCaller(this.options.database, authority, input.callerProvider),
        );
    }

    /**
     * Admits one task, creating its Session first for `newSession`; see `admitDelegationRequest`.
     */
    create(
        id: string,
        authority: DelegationAuthority,
        request: AgentDelegationCreateRequest,
    ): Promise<AgentDelegationReceipt> {
        return admitDelegationRequest(this.options, id, authority, request, (input, isNewSession) =>
            this.createInSession(id, authority, input, isNewSession),
        );
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
        this.armStartupDeadline(record.receipt.delegationId, terminalId, launchId);
        return true;
    }

    bindEnvironment(
        terminalId: string,
        launchId: string,
        environment: NodeJS.ProcessEnv,
        delegationId?: string,
    ): void {
        if (!this.bindTerminalLaunch(terminalId, launchId, delegationId)) return;
        if (!environment.CAXRI_HOOK_TOKEN)
            throw new CaxriError(
                'UNAVAILABLE',
                'Visible delegation requires active lifecycle hooks',
            );
        environment.CAXRI_HOOK_DIGEST = '1';
    }

    /**
     * {@link bindEnvironment} for a Chat launch, which reports turns and their digests through its provider protocol
     * instead of lifecycle hooks.
     */
    bindChatLaunch(terminalId: string, launchId: string, delegationId?: string): void {
        this.bindTerminalLaunch(terminalId, launchId, delegationId);
    }

    observe(signal: AgentLifecycleSignal, source: 'lifecycle' | 'evidence' = 'lifecycle'): void {
        const record = this.activeForTerminal(signal.terminalId);
        if (!record) return;
        const next = applyDelegationLifecycle(record, signal, source, this.options.isChatTerminal);
        if (next) {
            const saved = this.save(next);
            // A session that starts past the deadline gets a fresh one, so a turn that never follows still settles.
            if (record.receipt.status === 'blocked' && saved.receipt.status === 'awaiting_ready')
                this.armStartupDeadline(
                    saved.receipt.delegationId,
                    signal.terminalId,
                    saved.launchId!,
                );
            if (saved.turnId || !isDelegationActive(saved.receipt)) {
                clearTimeout(this.submissionTimers.get(saved.receipt.delegationId));
                this.submissionTimers.delete(saved.receipt.delegationId);
            }
            if (shouldCollectDelegation(saved)) this.scheduleCollection(saved);
        }
    }

    status(id: string, authority: DelegationAuthority): AgentDelegationReceipt {
        return this.owned(id, authority, 'existing').receipt;
    }

    stop(id: string, authority: DelegationAuthority): AgentDelegationReceipt {
        const record = this.owned(id, authority, 'existing');
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
            const { next, shouldCollect } = recoveredDelegation(
                record,
                this.options.isChatTerminal,
            );
            const saved = this.save(next, false);
            if (shouldCollect) this.scheduleCollection(saved);
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
        ids: readonly [string, ...string[]],
        authority: DelegationAuthority,
        timeoutMs: number,
        signal?: AbortSignal,
    ) {
        if (this.waiterCount >= 64) throw new CaxriError('CAPACITY', 'Too many delegation waiters');
        this.waiterCount++;
        try {
            return await pollDelegations(
                ids,
                (id) => this.result(id, authority),
                () => this.isClosed,
                timeoutMs,
                signal,
            );
        } finally {
            this.waiterCount--;
        }
    }

    interruptTerminal(terminalId: string, isHumanInput = false, retiredLaunchId?: string): void {
        const starting = this.activeForTerminal(terminalId);
        if (isHumanInput && starting && isStartupPromptInput(starting)) {
            this.save({ ...starting, inputEpoch: this.options.inputEpoch?.(terminalId) });
            return;
        }
        /**
         * A completed answer stays readable, but human takeover permanently revokes its continuation authority. Persist
         * once per Terminal lifetime because the input epoch alone is lost on Server restart.
         */
        if (isHumanInput && !this.humanIntervenedTerminals.has(terminalId)) {
            this.humanIntervenedTerminals.add(terminalId);
            for (const task of this.options.database.agentDelegations.forTerminal(terminalId))
                if (!task.hasHumanIntervention) this.save({ ...task, hasHumanIntervention: true });
        }
        // Re-read: the takeover mark above may have just rewritten the active task.
        const record = this.activeForTerminal(terminalId);
        const next = record && interruptedDelegation(record, isHumanInput, retiredLaunchId);
        if (next) this.save(next);
    }

    async result(id: string, authority: DelegationAuthority) {
        const record = this.owned(id, authority, 'existing');
        if (
            !shouldCollectDelegation(record) ||
            performance.now() < (this.nextCollections.get(id) ?? 0)
        )
            return { receipt: record.receipt, answer: record.answer };
        return this.collections.run(id, () => {
            // Many waiters share one bounded transcript read per poll interval.
            this.nextCollections.set(
                id,
                performance.now() + collectionIntervalMs(record.receipt.provider),
            );
            return this.collectResult(id, authority);
        });
    }
}
