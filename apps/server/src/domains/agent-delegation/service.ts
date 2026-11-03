import { createHash } from 'node:crypto';

import type {
    AgentDelegationCreate,
    AgentDelegationCreateRequest,
    AgentDelegationReceipt,
    AgentDelegationSession,
} from '@caxri/protocol';
import { agentDelegationSettingsSchema, CaxriError, isDelegationActive } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';

import type { AgentLifecycleSignal } from '../agents';
import type { StoredAgentDelegation } from '../db';
import type { DelegationAccess, DelegationAuthority } from './admission';
import {
    admittedDelegation,
    authorizeDelegationSession,
    delegationCaller,
    delegationRoster,
    isCaxriBotCaller,
    resolveDelegationAdmission,
} from './admission';
import { assertTerminalChildHooks, childLaunchFailure } from './chat-child';
import { readDelegationCompletion } from './collection';
import { logDelegationRequested, logDelegationTransition } from './diagnostics';
import {
    DelegationProgress,
    delegationSessions,
    isNewlyCompleted,
    recordDelegationResult,
} from './feed';
import { startFreshTask } from './fresh-start';
import { fenceTerminalLaunch } from './launch-fence';
import {
    applyDelegationLifecycle,
    canFailDelegation,
    isReceiptTransition,
    recoveredDelegation,
    withHumanIntervention,
} from './lifecycle';
import { admitDelegationRequest } from './new-session';
import { isDelegationOwner, listOwnedDelegations } from './ownership';
import { stampedReceipt } from './receipt-timing';
import { applyDelegationCompletion, collectionIntervalMs, shouldCollectDelegation } from './result';
import type { ExactResumeHost } from './resume';
import {
    continueHandover,
    followUpTask,
    handoverAdmission,
    handoverTarget,
    resumeTask,
} from './resume';
import type { RetryAdmission } from './retry';
import { assertRetryProvider, DelegationRetries } from './retry';
import type { AgentDelegationServiceOptions } from './service-options';
import { interruptedDelegation, isStartupPromptInput, startupDeadlineOutcome } from './startup';
import { reclaimPrunedDelegationFiles, removeDelegationFiles } from './storage';
import { DelegationSubmissions } from './submission';
import { pollDelegations } from './wait';

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
        Pick<StoredAgentDelegation, 'answer' | 'receipt'>
    >();
    private isClosed = false;
    private waiterCount = 0;
    private readonly deletingSessions = new Set<string>();
    private readonly pendingCreations = new Map<string, Set<Promise<AgentDelegationReceipt>>>();

    private readonly submissions: DelegationSubmissions;
    private readonly progress?: DelegationProgress;
    private readonly retries: DelegationRetries;

    constructor(private readonly options: AgentDelegationServiceOptions) {
        this.now = options.now ?? Date.now;
        this.submissions = new DelegationSubmissions(options, (id, failure) =>
            this.fail(id, failure),
        );
        this.retries = new DelegationRetries({
            options,
            save: (record, isAnnounced) => this.save(record, isAnnounced),
            hasActiveTask: (terminalId) => Boolean(this.activeForTerminal(terminalId)),
            admit: (id, authority, input, isNewSession, retry) =>
                this.createInSession(id, authority, input, isNewSession, retry),
        });
        if (options.onProgress)
            this.progress = new DelegationProgress(
                (progress) => options.onProgress?.(progress),
                this.now,
            );
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
            receipt: stampedReceipt(record, before?.receipt, this.now(), (failure) =>
                this.options.limitResetsAt?.(failure),
            ),
        });
        const { delegationId, sessionId, terminalId } = saved.receipt;
        if (terminalId) {
            if (isDelegationActive(saved.receipt)) {
                this.activeTerminals.set(terminalId, delegationId);
                this.progress?.track(delegationId, sessionId);
            } else if (this.activeTerminals.get(terminalId) === delegationId)
                this.activeTerminals.delete(terminalId);
        }
        if (!isDelegationActive(saved.receipt)) {
            this.nextCollections.delete(delegationId);
            this.progress?.settle(delegationId);
        }
        if (isNewlyCompleted(saved, before))
            recordDelegationResult(this.options.database, saved, this.options.logger);
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

    private exactResumeHost(
        authority: DelegationAuthority,
        retry?: RetryAdmission,
    ): ExactResumeHost {
        return {
            beforeStart: retry && (() => retry.guard()),
            hasActiveTask: (terminalId) => Boolean(this.activeForTerminal(terminalId)),
            options: this.options,
            owned: (id) => this.owned(id, authority),
            save: (record) => this.save(record),
            fail: (id, failure) => this.fail(id, failure),
            isDeleting: (sessionId) => this.deletingSessions.has(sessionId),
            submit: (...submission) => this.submissions.submit(...submission),
        };
    }

    /**
     * Settles a launch that has not started its turn by the deadline; see `startupDeadlineOutcome`.
     */
    private armStartupDeadline(id: string, terminalId: string, launchId: string): void {
        this.submissions.arm(id, () => {
            const current = this.options.database.agentDelegations.get(id);
            const isAlive = this.options.currentLaunchId?.(terminalId) === launchId;
            const outcome = current && startupDeadlineOutcome(current, isAlive);
            if (outcome === 'startup_not_ready') this.fail(id, outcome);
            else if (outcome) this.save(outcome);
        });
    }

    private async createInSession(
        id: string,
        authority: DelegationAuthority,
        input: AgentDelegationCreate,
        isNewSession: boolean,
        retry?: RetryAdmission,
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
            const handoverRequest = continueFromHandover
                ? ([
                      this.options,
                      authority,
                      { ...input, continueFromHandover },
                      (terminal: string) => Boolean(this.activeForTerminal(terminal)),
                  ] as const)
                : undefined;
            const handover = handoverRequest && handoverTarget(...handoverRequest);
            const config = resolveDelegationAdmission({
                ...this.options,
                authority,
                input: handover ? { ...input, provider: handover.provider } : input,
                previous,
                settings:
                    this.options.delegationSettings?.() ?? agentDelegationSettingsSchema.parse({}),
                inherited: retry?.inherited,
            });
            assertRetryProvider(retry, config.selection);
            const { frozenLaunch } = config;
            if (!previous || input.resumeFrom)
                await this.options.verifyLaunch(frozenLaunch, config.selection.provider);
            // After the last await before the record exists, so input during `verifyLaunch` is fenced.
            retry?.guard();
            const admitted = handoverRequest && handoverAdmission(...handoverRequest);
            const record = this.options.database.agentDelegations.insert(
                admittedDelegation({
                    id,
                    now: this.now(),
                    authority,
                    input,
                    fingerprint,
                    admission: config,
                    previous,
                    providerSessionId: handover?.providerSessionId,
                    retryOf: retry?.retryOf,
                }),
                (pruned) => reclaimPrunedDelegationFiles(this.options.userDataPath, pruned),
            );
            // Before the announcement, so the ledger links the hand-over's task instead of recording a second one.
            if (continueFromHandover) this.options.botHandovers?.consume(continueFromHandover, id);
            logDelegationRequested(this.options.logger, record.receipt, input, {
                isBot: isCaxriBotCaller(this.options.database, authority),
                parentDelegationId: previousId,
                terminalId: authority.callerTerminalId,
                relation: this.options.database.getSession(input.sessionId)?.createdByRelation,
            });
            this.options.onReceiptChanged?.(record.receipt);
            try {
                if (admitted && continueFromHandover)
                    return await continueHandover(
                        this.exactResumeHost(authority),
                        record,
                        authority,
                        { ...admitted, handoverId: continueFromHandover },
                    );
                if (previous)
                    return await (input.resumeFrom
                        ? resumeTask(
                              this.exactResumeHost(authority, retry),
                              record,
                              authority,
                              previous,
                          )
                        : followUpTask(this.exactResumeHost(authority), record, previous));
                const early = await startFreshTask(
                    this.exactResumeHost(authority, retry),
                    record,
                    authority,
                    input,
                    config,
                );
                if (early) return early;
            } catch (error) {
                this.fail(id, childLaunchFailure(error));
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

    /**
     * The Sessions the named Sessions created, with each one's newest task and stored result; see `delegationSessions`.
     * A read for the owner's Delegated Sessions feed: it claims no answer.
     */
    sessions(createdBySessionIds: readonly string[]): AgentDelegationSession[] {
        return delegationSessions(this.options, createdBySessionIds);
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
        const active = this.activeForTerminal(terminalId);
        assertTerminalChildHooks(this.options, active?.receipt.provider, environment);
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
            if (saved.turnId || !isDelegationActive(saved.receipt))
                this.submissions.clear(saved.receipt.delegationId);
            if (shouldCollectDelegation(saved)) this.scheduleCollection(saved);
        }
    }

    /**
     * Called after a Chat's projection changed: publishes the step of the active task running in `terminalId`, if the
     * step changed; see {@link DelegationProgress}. A Terminal with no active task costs one map lookup.
     */
    observeChatProgress(terminalId: string): void {
        const delegationId = this.activeTerminals.get(terminalId);
        if (delegationId) this.progress?.observe(delegationId, this.options.chatStep?.(terminalId));
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

    /**
     * Owner-only retry of a failed task; see {@link DelegationRetries}.
     */
    retry(...request: Parameters<DelegationRetries['retry']>) {
        return this.retries.retry(...request);
    }

    retryOptions(failedId: string) {
        return this.retries.options(failedId);
    }

    initialize(): void {
        this.retries.recoverClaims();
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
        this.submissions.close();
        this.progress?.close();
        this.collectors.clear();
        this.activeTerminals.clear();
        this.nextCollections.clear();
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
        // A completed answer stays readable, but takeover revokes its continuation authority for good. Persisted on
        // each task that still lacks the mark (the input epoch alone is lost on restart), dated for the feed's
        // `takenOverAt`. Deliberately not guarded per Terminal: a task delegated into a Terminal the user already
        // typed in must still be marked by the next input.
        if (isHumanInput)
            for (const task of this.options.database.agentDelegations.forTerminal(terminalId))
                if (!task.hasHumanIntervention) this.save(withHumanIntervention(task, this.now()));
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
