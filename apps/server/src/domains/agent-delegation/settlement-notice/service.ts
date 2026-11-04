import type { DelegationApprovalChanged, DelegationQuestionChanged } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal } from '../../agents';
import type { DelegationNoticeKind, StoredAgentDelegation, StoredDelegationNotice } from '../../db';
import type { AgentDelegationServiceOptions } from '../service-options';
import { acknowledgeRead } from './acknowledge';
import type { NoticeOutcome, NoticeReason, SettlementNoticeSources } from './contract';
import { noticeCallerOf } from './eligibility';
import { PtyIdleProof } from './pty-proof';
import type { NoticeItem } from './text';
import { formatSettlementNotice, MAX_NOTICE_ITEMS } from './text';
import { NoticeWaiters } from './waiters';

type NoticeOptions = Pick<
    AgentDelegationServiceOptions,
    | 'chatCallerState'
    | 'currentLaunchId'
    | 'database'
    | 'deliverNotice'
    | 'inputEpoch'
    | 'isChatTerminal'
    | 'isIdle'
    | 'logger'
    | 'noticeTiming'
    | 'now'
>;

/**
 * How long after a Chat notice was written the Chat is assumed to still be starting its turn when its projection has
 * not yet shown it busy, so a second flush cannot write into the same idle-looking Chat.
 */
const CHAT_RESEND_GUARD_MS = 10_000;

/**
 * How long after a PTY turn finished the idle proof is asked again, since the Terminal's own idle proof lands after the
 * lifecycle signal.
 */
const PTY_IDLE_RECHECK_MS = 1000;

/**
 * How long a notice may wait for a caller that has no live launch. A caller that was stopped or whose Chat was not
 * reopened after a restart may come back, but a notice that old no longer wakes anyone usefully, so it is dropped.
 */
export const NOTICE_MAX_ABSENT_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TIMING = { quietMs: 1500, recheckMs: 10_000 };

interface Drop {
    kind: 'skip' | 'discard';
    reason: NoticeReason;
}
type Verdict = Drop | { kind: 'send' } | { kind: 'defer'; reason: NoticeReason };

interface Group {
    terminalId: string;
    launchId: string;
}

/**
 * Wakes the Agent that delegated a task when the task settles, asks it a question, or needs its approval, so a
 * delegating Agent never has to sit in `wait` to hear back. One notice per event, kept in the `delegation_notices`
 * table so a Server restart neither loses nor repeats it; see `docs/agent-delegation.md`.
 *
 * A notice is a plain write to the delegating Agent's own Terminal: a Chat takes it as a message that starts a turn, a
 * PTY as a pasted line, and only when the caller is proven to be at an idle, empty prompt. Everything is re-read at
 * send time, so an outcome the caller already read, an answered question, or a decided request is never announced. A
 * claim moves a notice to `unknown` before the write, which is never sent again: a duplicate wake costs the user more
 * than a missed one the caller finds on its next `list`.
 */
export class SettlementNotices {
    private static key(group: Group): string {
        return `${group.terminalId}\0${group.launchId}`;
    }

    private readonly waiters = new NoticeWaiters();
    private readonly proof: PtyIdleProof;
    private readonly timing: { quietMs: number; recheckMs: number };
    private readonly groups = new Map<string, Group>();
    private readonly timers = new Map<string, { handle: NodeJS.Timeout; due: number }>();
    /**
     * Eligible active tasks per caller Terminal, with the launch that delegated each, for the idle-suspension hold.
     */
    private readonly active = new Map<string, Map<string, string>>();
    private readonly deferrals = new Map<string, { count: number; reason: NoticeReason }>();
    private readonly sent = new Map<string, { at: number; sawBusy: boolean }>();
    private isClosed = false;

    constructor(
        private readonly options: NoticeOptions,
        private readonly sources: SettlementNoticeSources,
    ) {
        this.timing = options.noticeTiming ?? DEFAULT_TIMING;
        this.proof = new PtyIdleProof(options);
    }

    private get isEnabled(): boolean {
        return this.options.deliverNotice !== undefined;
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    private get store() {
        return this.options.database.agentDelegations.notices;
    }

    private log(
        outcome: NoticeOutcome,
        fields: {
            kind: DelegationNoticeKind | 'mixed';
            reason?: NoticeReason;
            batchSize?: number;
            waitMs?: number;
            deferrals?: number;
        },
    ): void {
        this.options.logger?.write(
            outcome === 'unknown' || outcome === 'failed' ? 'warn' : 'info',
            logEventCatalog.agentDelegation.settlementNotice,
            { fields: { outcome, ...fields } },
        );
    }

    private register(
        record: StoredAgentDelegation,
        id: string,
        kind: DelegationNoticeKind,
        subjectId?: string,
    ): void {
        const caller = noticeCallerOf(this.options.database, record);
        if ('reason' in caller) {
            this.log('skipped', { kind, reason: caller.reason });
            return;
        }
        const isStored = this.store.register({
            id,
            delegationId: record.receipt.delegationId,
            kind,
            subjectId,
            callerTerminalId: caller.terminalId,
            callerLaunchId: caller.launchId,
            now: this.now(),
        });
        if (!isStored) return;
        this.log('pending', { kind });
        const group = { terminalId: caller.terminalId, launchId: caller.launchId };
        this.groups.set(SettlementNotices.key(group), group);
        this.schedule(SettlementNotices.key(group), this.timing.quietMs, true);
    }

    private hasGroup(terminalId: string): boolean {
        for (const group of this.groups.values()) if (group.terminalId === terminalId) return true;
        return false;
    }

    private kick(terminalId: string, delayMs = 0): void {
        for (const [key, group] of this.groups)
            if (group.terminalId === terminalId) this.schedule(key, delayMs, false);
    }

    /**
     * Arms the group's timer. A new event restarts the quiet window (`isReset`); a re-check only brings the timer
     * forward, never pushes it back.
     */
    private schedule(key: string, delayMs: number, isReset: boolean): void {
        if (this.isClosed) return;
        const due = this.now() + delayMs;
        const existing = this.timers.get(key);
        if (existing) {
            if (!isReset && existing.due <= due) return;
            clearTimeout(existing.handle);
        }
        const handle = setTimeout(() => {
            this.timers.delete(key);
            this.flush(key);
        }, delayMs);
        handle.unref();
        this.timers.set(key, { handle, due });
    }

    private judge(notice: StoredDelegationNotice): Verdict {
        const record = this.options.database.agentDelegations.get(notice.delegationId);
        if (!record) return { kind: 'skip', reason: 'resolved' };
        if (notice.acknowledgedAt !== undefined) return { kind: 'skip', reason: 'acknowledged' };
        const { receipt } = record;
        // A hand-back is owed while the user's grant stands, whatever state the task is in and whoever waits.
        if (notice.kind === 'handback')
            return this.sources.isHandBackPending(notice.subjectId!)
                ? { kind: 'send' }
                : { kind: 'skip', reason: 'resolved' };
        if (notice.kind === 'settled') {
            if (isDelegationActive(receipt)) return { kind: 'skip', reason: 'resolved' };
            if (receipt.retriedAs) return { kind: 'discard', reason: 'retry_pending' };
            return this.waiters.isWaitingForSettlement(notice.callerTerminalId, notice.delegationId)
                ? { kind: 'defer', reason: 'waiter' }
                : { kind: 'send' };
        }
        const isOpen =
            isDelegationActive(receipt) &&
            (notice.kind === 'question'
                ? this.sources.isQuestionWithParent(notice.delegationId, notice.subjectId!)
                : this.sources.isApprovalDecidable(notice.delegationId, notice.subjectId!));
        if (!isOpen) return { kind: 'skip', reason: 'resolved' };
        return this.waiters.isWaitingForQuestions(notice.callerTerminalId, notice.delegationId)
            ? { kind: 'defer', reason: 'waiter' }
            : { kind: 'send' };
    }

    /**
     * Why the caller cannot take a write now, or undefined when it can.
     */
    private callerGate(group: Group, liveLaunchId: string | undefined): NoticeReason | undefined {
        if (liveLaunchId === undefined) return 'paused';
        if (this.options.isChatTerminal?.(group.terminalId)) {
            const state = this.options.chatCallerState?.(group.terminalId);
            const guard = this.sent.get(group.terminalId);
            if (state === 'busy' && guard) guard.sawBusy = true;
            if (state === 'busy') return 'busy';
            if (state !== 'idle') return 'paused';
            return guard && !guard.sawBusy && this.now() - guard.at < CHAT_RESEND_GUARD_MS
                ? 'busy'
                : undefined;
        }
        const proven = this.proof.check(group.terminalId, group.launchId);
        return proven === 'ok' ? undefined : proven;
    }

    private drop(notice: StoredDelegationNotice, verdict: Drop) {
        this.deferrals.delete(notice.id);
        if (verdict.kind === 'discard') this.store.discard(notice.id);
        else this.store.claim([notice.id], 'skipped', this.now());
        this.log('skipped', { kind: notice.kind, reason: verdict.reason });
    }

    private defer(notice: StoredDelegationNotice, reason: NoticeReason): void {
        const seen = this.deferrals.get(notice.id);
        this.deferrals.set(notice.id, { count: (seen?.count ?? 0) + 1, reason });
        // Once per notice and reason: a notice that waits on a busy Chat must not log on every re-check.
        if (seen?.reason !== reason) this.log('deferred', { kind: notice.kind, reason });
    }

    private flush(key: string): void {
        const group = this.groups.get(key);
        if (!group || this.isClosed) return;
        const rows = this.store.pendingFor(group.terminalId, group.launchId);
        if (rows.length === 0) {
            this.groups.delete(key);
            return;
        }
        const liveLaunchId = this.options.currentLaunchId?.(group.terminalId);
        const isGone = !this.options.database.getTerminal(group.terminalId);
        const staleReason: NoticeReason | undefined = isGone
            ? 'caller_gone'
            : liveLaunchId !== undefined && liveLaunchId !== group.launchId
              ? 'launch_changed'
              : undefined;
        if (staleReason) {
            for (const row of rows) this.drop(row, { kind: 'skip', reason: staleReason });
            this.groups.delete(key);
            return;
        }
        const ready: StoredDelegationNotice[] = [];
        let heldBack = 0;
        for (const row of rows) {
            const isAbsentTooLong =
                liveLaunchId === undefined && this.now() - row.createdAt > NOTICE_MAX_ABSENT_MS;
            const verdict = isAbsentTooLong
                ? ({ kind: 'skip', reason: 'caller_gone' } as const)
                : this.judge(row);
            if (verdict.kind === 'send') ready.push(row);
            else if (verdict.kind === 'defer') {
                heldBack += 1;
                this.defer(row, verdict.reason);
            } else this.drop(row, verdict);
        }
        const gate = ready.length > 0 ? this.callerGate(group, liveLaunchId) : undefined;
        if (gate) {
            for (const row of ready) this.defer(row, gate);
            heldBack += ready.length;
        } else if (ready.length > 0) {
            const batch = ready.slice(0, MAX_NOTICE_ITEMS);
            heldBack += ready.length - batch.length;
            if (!this.send(group, batch)) heldBack += batch.length;
        }
        if (heldBack > 0) this.schedule(key, this.timing.recheckMs, false);
        else if (this.store.pendingFor(group.terminalId, group.launchId).length === 0)
            this.groups.delete(key);
    }

    /**
     * Returns false when the write was refused before anything was sent and the notices went back to `pending`.
     */
    private send(group: Group, batch: readonly StoredDelegationNotice[]): boolean {
        const now = this.now();
        const claimed = new Set(
            this.store.claim(
                batch.map((notice) => notice.id),
                'unknown',
                now,
            ),
        );
        const rows = batch.filter((notice) => claimed.has(notice.id));
        if (rows.length === 0) return true;
        const items = rows.map((notice): NoticeItem => {
            const record = this.options.database.agentDelegations.get(notice.delegationId)!;
            return {
                delegationId: notice.delegationId,
                kind: notice.kind,
                ...(notice.kind === 'settled' && { status: record.receipt.status }),
                ...(notice.kind === 'handback' && { sessionId: record.receipt.sessionId }),
            };
        });
        const kinds = new Set(rows.map((notice) => notice.kind));
        const summary = {
            kind: kinds.size === 1 ? rows[0].kind : ('mixed' as const),
            batchSize: rows.length,
            waitMs: Math.max(...rows.map((notice) => now - notice.createdAt)),
            deferrals: rows.reduce(
                (sum, notice) => sum + (this.deferrals.get(notice.id)?.count ?? 0),
                0,
            ),
        };
        const settle = (to: 'delivered' | 'pending') => {
            for (const notice of rows) {
                this.deferrals.delete(notice.id);
                this.store.settle(notice.id, 'unknown', to, this.now());
            }
        };
        let hasReturned = false;
        let early: boolean | undefined;
        const finish = (isAccepted: boolean) => {
            if (isAccepted) {
                settle('delivered');
                this.log('delivered', summary);
            } else this.log('unknown', summary);
        };
        let isAdmitted = false;
        try {
            isAdmitted = this.options.deliverNotice!(
                group.terminalId,
                group.launchId,
                formatSettlementNotice(items),
                (isAccepted) => {
                    if (hasReturned) finish(isAccepted);
                    else early = isAccepted;
                },
            );
        } catch {
            this.log('failed', summary);
        }
        hasReturned = true;
        if (!isAdmitted) {
            // Refused before anything was written: safe to try again.
            settle('pending');
            return false;
        }
        this.sent.set(group.terminalId, { at: now, sawBusy: false });
        this.proof.spend(group.terminalId);
        if (early !== undefined) finish(early);
        return true;
    }

    /**
     * Called after every task save. A task that became settled owes its caller a notice, unless a retry of it is
     * planned or running (its successor reports instead); an active task is remembered for the suspension hold.
     */
    recorded(saved: StoredAgentDelegation, before: StoredAgentDelegation['receipt'] | undefined) {
        if (!this.isEnabled) return;
        const { delegationId, callerTerminalId } = saved.receipt;
        if (isDelegationActive(saved.receipt)) {
            if (callerTerminalId && !this.active.get(callerTerminalId)?.has(delegationId)) {
                const caller = noticeCallerOf(this.options.database, saved);
                if ('terminalId' in caller) {
                    const mine = this.active.get(caller.terminalId) ?? new Map<string, string>();
                    this.active.set(caller.terminalId, mine.set(delegationId, caller.launchId));
                }
            }
            return;
        }
        if (callerTerminalId) {
            const mine = this.active.get(callerTerminalId);
            if (mine?.delete(delegationId) && mine.size === 0) this.active.delete(callerTerminalId);
        }
        const isTransition = !before || isDelegationActive(before);
        const isRetryReleased = Boolean(before?.retriedAs) && !saved.receipt.retriedAs;
        if (!isTransition && !isRetryReleased) return;
        if (saved.receipt.retriedAs) {
            this.log('skipped', { kind: 'settled', reason: 'retry_pending' });
            return;
        }
        this.register(saved, `settled:${delegationId}`, 'settled');
    }

    /**
     * The user handed a taken-over Session back: the delegating Agent is told once, and any settlement notice of the
     * Session's taken-over tasks that is still waiting is dropped, since "the user took over" is no longer the news.
     */
    handedBack(anchor: StoredAgentDelegation, grantId: string): void {
        if (!this.isEnabled) return;
        const now = this.now();
        for (const task of this.options.database.agentDelegations.forSession(
            anchor.receipt.sessionId,
        ))
            if (task.receipt.status === 'human_intervened') {
                const stale = this.store
                    .forDelegation(task.receipt.delegationId, 'settled')
                    .filter((notice) => notice.state === 'pending');
                this.store.claim(
                    stale.map((notice) => notice.id),
                    'skipped',
                    now,
                );
            }
        this.register(anchor, `handback:${grantId}`, 'handback', grantId);
    }

    /**
     * The turn whose finish proves the Agent in `terminalId` idle at `launchId`, or `undefined` without that proof. A
     * grant pins it, so a turn that starts afterwards drops the grant.
     */
    childIdleTurn(terminalId: string, launchId: string): string | undefined {
        return this.proof.idleTurn(terminalId, launchId);
    }

    /**
     * Whether a Terminal Agent's prompt holds text that was typed after its turn started and not submitted.
     */
    hasDraft(terminalId: string, launchId: string): boolean {
        return this.proof.check(terminalId, launchId) === 'draft';
    }

    questionChanged(change: DelegationQuestionChanged): void {
        if (!this.isEnabled || change.state !== 'open' || change.escalated) return;
        const record = this.options.database.agentDelegations.get(change.delegationId);
        if (record)
            this.register(record, `question:${change.questionId}`, 'question', change.questionId);
    }

    approvalChanged(change: DelegationApprovalChanged): void {
        if (!this.isEnabled || change.state !== 'pending') return;
        const record = this.options.database.agentDelegations.get(change.delegationId);
        if (record)
            this.register(
                record,
                `approval:${change.delegationId}:${change.requestId}`,
                'approval',
                change.requestId,
            );
    }

    /**
     * Registers an open `wait` of the caller, so a notice never repeats an outcome that wait is about to report. The
     * release re-checks the caller afterwards, after the wait's own handler had its chance to acknowledge.
     */
    waiting(
        { callerTerminalId: terminalId }: { callerTerminalId?: string },
        delegationIds: readonly string[],
        shouldIgnoreQuestions: boolean,
    ): () => void {
        if (!terminalId || !this.isEnabled) return () => {};
        const release = this.waiters.register(terminalId, delegationIds, shouldIgnoreQuestions);
        return () => {
            release();
            setTimeout(() => this.kick(terminalId), 0).unref();
        };
    }

    /**
     * The caller read what a notice would report, through `wait` or `result`. Only the Agent that the notice is owed to
     * counts: another caller reading the task does not tell the delegating Agent anything.
     */
    readOutcome<T extends { receipt: StoredAgentDelegation['receipt']; outcome?: string }>(
        read: T,
        { callerTerminalId }: { callerTerminalId?: string },
    ): T {
        if (callerTerminalId && this.isEnabled)
            acknowledgeRead(this.options.database, this.now(), read, callerTerminalId);
        return read;
    }

    /**
     * The caller was just handed the task's receipt by the request that created or stopped it, so a settled receipt
     * needs no notice: it would wake the Agent about an outcome it has already read. Returns `receipt` for chaining.
     */
    told<T extends StoredAgentDelegation['receipt']>(
        receipt: T,
        authority: { callerTerminalId?: string },
    ): T {
        return this.readOutcome({ receipt }, authority).receipt;
    }

    /**
     * A lifecycle signal of a PTY Agent: feeds the idle proof and re-checks the caller once a turn finished.
     */
    observe(signal: AgentLifecycleSignal): void {
        if (!this.isEnabled) return;
        this.proof.observeLifecycle(signal);
        if (signal.phase === 'turnFinished' && !signal.agentId)
            this.kick(signal.terminalId, PTY_IDLE_RECHECK_MS);
    }

    observeInput(terminalId: string, data: string): void {
        if (this.isEnabled) this.proof.observeInput(terminalId, data);
    }

    /**
     * A Chat caller's projection changed: a busy projection ends the resend guard, an idle one re-checks the caller.
     */
    chatChanged(terminalId: string): void {
        if (!this.isEnabled || !this.hasGroup(terminalId)) return;
        const state = this.options.chatCallerState?.(terminalId);
        const guard = this.sent.get(terminalId);
        if (state === 'busy' && guard) guard.sawBusy = true;
        if (state === 'idle') this.kick(terminalId);
    }

    /**
     * The launch that delegated tasks was retired or the Terminal's state otherwise stopped being provable.
     */
    retired(terminalId: string): void {
        this.proof.forget(terminalId);
        this.sent.delete(terminalId);
        if (this.isEnabled) this.kick(terminalId);
    }

    /**
     * Whether the caller must not be suspended for being idle: a task it delegated is still running, or a notice is
     * owed to it. Suspending it would end the launch the notice is pinned to.
     */
    holds(terminalId: string): boolean {
        if (!this.isEnabled) return false;
        const launchId = this.options.currentLaunchId?.(terminalId);
        if (!launchId) return false;
        const mine = this.active.get(terminalId);
        if (mine) {
            // A deleted Session takes its tasks with it by cascade, without a save that would end the hold.
            for (const id of mine.keys())
                if (!this.options.database.agentDelegations.get(id)) mine.delete(id);
            if (mine.size === 0) this.active.delete(terminalId);
            if (mine.values().toArray().includes(launchId)) return true;
        }
        return this.store.hasPendingFor(terminalId, launchId);
    }

    /**
     * Re-checks every caller owed a notice after a restart. A notice of a launch that no longer exists is dropped by
     * the check itself.
     */
    initialize(): void {
        if (!this.isEnabled) return;
        for (const notice of this.store.pending()) {
            const group = {
                terminalId: notice.callerTerminalId,
                launchId: notice.callerLaunchId,
            };
            this.groups.set(SettlementNotices.key(group), group);
            this.schedule(SettlementNotices.key(group), this.timing.quietMs, false);
        }
    }

    close(): void {
        this.isClosed = true;
        for (const { handle } of this.timers.values()) clearTimeout(handle);
        this.timers.clear();
        this.groups.clear();
        this.active.clear();
    }
}
