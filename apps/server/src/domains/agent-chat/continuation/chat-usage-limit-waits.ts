import type {
    AgentChatAutoContinue,
    AgentChatAutoContinueSkipReason,
    AppSettings,
} from '@caxri/protocol';
import {
    AGENT_CHAT_AUTO_CONTINUE_HORIZON_MS,
    AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS,
    agentChatPendingKnownQueueLength,
    CaxriError,
    isChatTerminal,
    toWireError,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AppStateValue, CaxriDatabase } from '../../db';
import type { WatchHandle, WatchHub } from '../../watch';
import type { ChatStateDelivery, ChatStates } from '../chat-states';
import type { UsageLimitNotice } from './usage-continuation-stamp';

type StoredWait = AppStateValue<'agentChatUsageLimitWaits'>[number];

/**
 * Why a wait ended before its Chat continued: `userInput` (a message, command, rewind, Stop, or "Continue now"),
 * `cancelled` (the notice's Cancel), `continuedElsewhere` (Continue in another Agent), `disabled` (the setting was
 * turned off), and `closed` (the Chat's Terminal is gone, or its Session was archived).
 */
type CancelReason = 'cancelled' | 'closed' | 'continuedElsewhere' | 'disabled' | 'userInput';

/**
 * How often waits are checked. A continuation lands at most this long after its stagger ends.
 */
const SWEEP_INTERVAL_MS = 15_000;

/**
 * A wait that comes due this long after its time (the Mac slept through the reset, or Server Core was not running) does
 * not continue on its own: the user may have moved on, so the notice offers Continue instead. Claude Code asks the same
 * after a long sleep.
 */
const MISSED_AFTER_MS = 30 * 60_000;

/**
 * The stagger after a reset before a Chat continues, so Chats that hit the same limit do not all start at its first
 * second, when a provider may still count the old window.
 */
const MIN_STAGGER_MS = 30_000;
const MAX_STAGGER_MS = 120_000;

/**
 * The Chat service parts a wait drives; set once the service exists.
 */
export interface UsageLimitWaitChatHost {
    states: ChatStates;
    /**
     * Runs `deliver` on the Chat's send chain once its provider has started, as `AgentChatService` delivers any input.
     */
    deliver(terminalId: string, deliver: ChatStateDelivery): Promise<void>;
}

interface Options {
    database: Pick<CaxriDatabase, 'getAppState' | 'getSession' | 'getTerminal' | 'setAppState'>;
    logger: StructuredLogger;
    settings: () => Pick<AppSettings, 'agentChat.autoContinueAtUsageLimit'>;
    /**
     * Whether the Chat's account is at the weekly usage guard, which no reset of a shorter window lifts.
     */
    isUsageGuarded(terminalId: string): boolean;
    /**
     * A Chat's wait began, changed, or ended, so Clients re-read its Terminal (the Session row shows the wait).
     */
    onChange?(terminalId: string): void;
    now?: () => number;
    random?: () => number;
}

/**
 * Continues a Chat on its own once the plan limit that failed its last turn resets (issue #2220), the way Claude Code's
 * interactive sessions do (its SDK sessions, which a Chat runs, do not). One record per Chat in `app_state`, keyed by
 * the failed turn, so the wait survives a Server Core restart. The record is the notice's `autoContinue` state:
 * `waiting` until the reset plus a stagger, `continued`, `missed` when it came due too late, or `skipped` with why it
 * never waited. Anything the user does in the Chat ends the wait, and a continuation that fails again counts toward
 * {@link AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS}.
 */
export class ChatUsageLimitWaits {
    private chat: UsageLimitWaitChatHost | undefined;
    private readonly records: Map<string, StoredWait>;
    private readonly firing = new Set<string>();
    /**
     * The failed turn each Chat last armed a wait for in this process, so re-upserting that turn's notice after its
     * wait ended (to drop the stamp) does not arm it again.
     */
    private readonly observed = new Map<string, string>();
    private poller: WatchHandle | undefined;
    private sweeping: Promise<void> | undefined;

    constructor(private readonly options: Options) {
        this.records = new Map(
            (options.database.getAppState('agentChatUsageLimitWaits') ?? []).map((record) => [
                record.terminalId,
                record,
            ]),
        );
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private stagger(): number {
        const random = this.options.random?.() ?? Math.random();
        return MIN_STAGGER_MS + Math.round(random * (MAX_STAGGER_MS - MIN_STAGGER_MS));
    }

    private save(terminalId: string): void {
        this.options.database.setAppState(
            'agentChatUsageLimitWaits',
            this.records.values().toArray(),
        );
        this.options.onChange?.(terminalId);
    }

    private log(
        record: StoredWait,
        outcome:
            'cancelled' | 'continued' | 'failed' | 'missed' | 'rescheduled' | 'skipped' | 'waiting',
        extra: { reason?: string; code?: string; manual?: boolean } = {},
    ): void {
        this.options.logger.write(
            outcome === 'failed' ? 'warn' : 'info',
            logEventCatalog.usage.autoContinue,
            {
                fields: {
                    terminalId: record.terminalId,
                    provider: record.provider,
                    window: record.window,
                    outcome,
                    reason: extra.reason ?? null,
                    code: extra.code ?? null,
                    attempt: record.attempt,
                    waitedMs: this.now() - record.failedAt,
                    ...(extra.manual && { manual: true }),
                },
            },
        );
    }

    /**
     * Re-upserts the record's notice so the projection stamps its current state (see `stampUsageContinuations`).
     */
    private refresh(terminalId: string, turnId: string): void {
        const state = this.chat?.states.get(terminalId);
        const notice = state?.projection.snapshot.items.find(
            (item) => item.id === `${turnId}:error`,
        );
        if (notice) this.chat!.states.apply(terminalId, [{ op: 'upsertItem', item: notice }]);
    }

    private update(record: StoredWait, autoContinue: AgentChatAutoContinue): void {
        record.autoContinue = autoContinue;
        this.records.set(record.terminalId, record);
        this.save(record.terminalId);
        this.refresh(record.terminalId, record.turnId);
    }

    /**
     * Whether a limit resetting at `resetsAt` may be waited for, or why not.
     */
    private plan(
        terminalId: string,
        resetsAt: number | undefined,
        attempt: number,
    ): AgentChatAutoContinue {
        const skip = (reason: AgentChatAutoContinueSkipReason): AgentChatAutoContinue => ({
            status: 'skipped',
            reason,
        });
        if (attempt > AGENT_CHAT_AUTO_CONTINUE_MAX_ATTEMPTS) return skip('attemptsUsed');
        const now = this.now();
        // A reset already past, or none at all, is not a time to continue at: the provider's figure is wrong or stale.
        if (resetsAt === undefined || resetsAt <= now) return skip('resetUnknown');
        if (resetsAt - now > AGENT_CHAT_AUTO_CONTINUE_HORIZON_MS) return skip('resetTooFar');
        if (this.options.isUsageGuarded(terminalId)) return skip('usageGuard');
        return { status: 'waiting', at: resetsAt + this.stagger() };
    }

    private async deliver(
        terminalId: string,
        beforeSend?: (session: Parameters<ChatStateDelivery>[0]) => Promise<'continue' | 'stop'>,
    ): Promise<void> {
        const chat = this.chat;
        if (!chat) throw new CaxriError('UNAVAILABLE', 'Agent Chat is not ready');
        await chat.deliver(terminalId, async (session, state) => {
            const { snapshot } = state.projection;
            if (
                state.followUps.mustWait() ||
                snapshot.requests.length > 0 ||
                agentChatPendingKnownQueueLength(snapshot) > 0
            )
                throw new CaxriError('CONFLICT', 'This Chat is busy');
            if (!session.continueAfterUsageLimit)
                throw new CaxriError('VALIDATION', 'This Agent cannot continue on its own');
            if ((await beforeSend?.(session)) === 'stop') return;
            await session.continueAfterUsageLimit();
        });
    }

    /**
     * A plan-limit reading the provider gave right before continuing: a window still used up and resetting later means
     * the provider reported the reset early, so the wait moves to the new reset instead of failing a turn into it.
     */
    private async stillLimitedUntil(
        session: Parameters<ChatStateDelivery>[0],
        record: StoredWait,
    ): Promise<number | undefined> {
        const read = async () => {
            try {
                return await session.readPlanLimits?.();
            } catch {
                return;
            }
        };
        const limits = await read();
        const now = this.now();
        const windows = (limits?.windows ?? []).filter(
            (window) =>
                window.usedPercent >= 100 &&
                window.resetsAt !== undefined &&
                window.resetsAt > now &&
                (record.window === 'unknown' || window.scope === record.window),
        );
        return windows.reduce<number | undefined>(
            (latest, window) => Math.max(latest ?? 0, window.resetsAt!),
            undefined,
        );
    }

    private async fire(record: StoredWait): Promise<void> {
        const { terminalId } = record;
        let outcome = 'continued' as 'continued' | 'rescheduled';
        try {
            await this.deliver(terminalId, async (session) => {
                if (this.records.get(terminalId) !== record) return 'stop';
                const until = await this.stillLimitedUntil(session, record);
                // A Cancel or a message during the limit read ends the wait; nothing is sent then.
                if (this.records.get(terminalId) !== record) return 'stop';
                if (until === undefined) return 'continue';
                outcome = 'rescheduled';
                record.attempt += 1;
                record.resetsAt = until;
                const next = this.plan(terminalId, until, record.attempt);
                this.update(record, next);
                this.log(record, next.status === 'waiting' ? 'rescheduled' : 'skipped', {
                    ...(next.status === 'skipped' && { reason: next.reason }),
                });
                return 'stop';
            });
        } catch (error) {
            if (this.records.get(terminalId) !== record) return;
            const { code } = toWireError(error);
            // Never retried on its own: a timed-out start may still have reached the provider.
            this.update(record, { status: 'missed' });
            this.log(record, 'failed', { code });
            return;
        }
        if (outcome === 'rescheduled' || this.records.get(terminalId) !== record) return;
        this.update(record, { status: 'continued', at: this.now() });
        this.log(record, 'continued');
    }

    private isClosed(terminalId: string): boolean {
        const { database } = this.options;
        const terminal = database.getTerminal(terminalId);
        // A switch to the PTY surface ends the wait like a close: only a Chat can continue on its own.
        if (!terminal || !isChatTerminal(terminal)) return true;
        return database.getSession(terminal.sessionId)?.archivedAt !== undefined;
    }

    private async runSweep(): Promise<void> {
        const isEnabled = this.options.settings()['agentChat.autoContinueAtUsageLimit'];
        for (const record of this.records.values()) {
            const { terminalId, autoContinue } = record;
            if (this.isClosed(terminalId)) {
                this.cancel(terminalId, 'closed');
                continue;
            }
            if (autoContinue.status !== 'waiting' || this.firing.has(terminalId)) continue;
            if (!isEnabled) {
                this.cancel(terminalId, 'disabled');
                continue;
            }
            const now = this.now();
            if (now < autoContinue.at) continue;
            if (now - autoContinue.at > MISSED_AFTER_MS) {
                this.update(record, { status: 'missed' });
                this.log(record, 'missed');
                continue;
            }
            if (this.options.isUsageGuarded(terminalId)) {
                this.update(record, { status: 'skipped', reason: 'usageGuard' });
                this.log(record, 'skipped', { reason: 'usageGuard' });
                continue;
            }
            this.firing.add(terminalId);
            // Chats continue one after another: each start spawns a provider process.
            try {
                // eslint-disable-next-line no-await-in-loop -- one provider start at a time, as above.
                await this.fire(record);
            } finally {
                this.firing.delete(terminalId);
            }
        }
    }

    attach(chat: UsageLimitWaitChatHost): void {
        this.chat = chat;
    }

    /**
     * The `autoContinue` state of the notice of a Chat's failed turn, or `undefined` when nothing waits for it.
     */
    stateOf(terminalId: string, turnId: string): AgentChatAutoContinue | undefined {
        const record = this.records.get(terminalId);
        return record?.turnId === turnId ? record.autoContinue : undefined;
    }

    /**
     * When the Chat continues on its own, or `undefined` unless it is waiting for a plan limit to reset.
     */
    waitingAt(terminalId: string): number | undefined {
        const autoContinue = this.records.get(terminalId)?.autoContinue;
        return autoContinue?.status === 'waiting' ? autoContinue.at : undefined;
    }

    /**
     * The notice a history replay must show again: one the user still has to see (a wait, or a missed one), which the
     * provider's own record does not keep (Claude Code's transcript has no failed-turn notice).
     */
    replayNotice(terminalId: string): UsageLimitNotice | undefined {
        const record = this.records.get(terminalId);
        if (!record || !['missed', 'waiting'].includes(record.autoContinue.status))
            return undefined;
        return {
            id: `${record.turnId}:error`,
            turnId: record.turnId,
            type: 'notice',
            kind: 'error',
            message: record.message,
            usageLimit: {
                window: record.window,
                ...(record.resetsAt !== undefined && { resetsAt: record.resetsAt }),
            },
            createdAt: record.failedAt,
        };
    }

    /**
     * A live turn failed on a used-up plan limit: arms the Chat's wait for its reset, or records why it will not wait.
     * The same turn again (Codex reports its failure twice, the second time with the reset) only re-plans a skipped
     * wait. A continuation that failed again into a limit counts one more attempt.
     */
    observeFailure(
        terminalId: string,
        provider: StoredWait['provider'],
        notice: UsageLimitNotice,
    ): void {
        if (!notice.turnId) return;
        const previous = this.records.get(terminalId);
        if (!this.options.settings()['agentChat.autoContinueAtUsageLimit']) {
            if (previous) this.cancel(terminalId, 'disabled');
            return;
        }
        // The same turn again re-plans only a skipped wait whose reset time changed (Codex names it in a second report).
        if (
            previous?.turnId === notice.turnId &&
            (previous.autoContinue.status !== 'skipped' ||
                previous.resetsAt === notice.usageLimit.resetsAt)
        )
            return;
        if (!previous && this.observed.get(terminalId) === notice.turnId) return;
        this.observed.set(terminalId, notice.turnId);
        const attempt =
            previous?.turnId === notice.turnId
                ? previous.attempt
                : previous?.autoContinue.status === 'continued' || this.firing.has(terminalId)
                  ? (previous?.attempt ?? 0) + 1
                  : 1;
        const { resetsAt, window } = notice.usageLimit;
        const record: StoredWait = {
            terminalId,
            turnId: notice.turnId,
            provider,
            window,
            ...(resetsAt !== undefined && { resetsAt }),
            message: (notice.message ?? '').slice(0, 2_000),
            failedAt: previous?.turnId === notice.turnId ? previous.failedAt : this.now(),
            attempt,
            autoContinue: this.plan(terminalId, resetsAt, attempt),
        };
        this.records.set(terminalId, record);
        this.save(terminalId);
        const { autoContinue } = record;
        if (autoContinue.status === 'skipped')
            this.log(record, 'skipped', { reason: autoContinue.reason });
        else this.log(record, 'waiting');
    }

    /**
     * Ends the Chat's wait, if any. With `turnId`, only that turn's wait, and a `CONFLICT` when it is not the one.
     */
    cancel(terminalId: string, reason: CancelReason, turnId?: string): void {
        const record = this.records.get(terminalId);
        if (turnId !== undefined && record?.turnId !== turnId)
            throw new CaxriError('CONFLICT', 'This usage limit is no longer waiting to continue');
        if (!record) return;
        this.records.delete(terminalId);
        this.save(terminalId);
        if (record.autoContinue.status === 'waiting') this.log(record, 'cancelled', { reason });
        // A settled notice (continued, skipped) keeps saying what happened; only its actions go.
        if (['missed', 'waiting'].includes(record.autoContinue.status))
            this.refresh(terminalId, record.turnId);
    }

    /**
     * "Continue now" on a waiting or missed notice: ends the wait and continues at once, without checking the limit.
     * `onHumanInput` runs once the wait is gone, so recording the click as human input cannot cancel it first.
     */
    async continueNow(
        terminalId: string,
        turnId: string,
        onHumanInput: () => void = () => {},
    ): Promise<void> {
        const record = this.records.get(terminalId);
        if (
            record?.turnId !== turnId ||
            !['missed', 'waiting'].includes(record.autoContinue.status)
        )
            throw new CaxriError('CONFLICT', 'This usage limit is no longer waiting to continue');
        this.records.delete(terminalId);
        this.save(terminalId);
        this.refresh(terminalId, turnId);
        onHumanInput();
        try {
            await this.deliver(terminalId);
        } catch (error) {
            // A busy Chat or a failed start keeps the notice's Continue, unless something else replaced the wait.
            if (!this.records.has(terminalId)) {
                this.records.set(terminalId, { ...record, autoContinue: { status: 'missed' } });
                this.save(terminalId);
                this.refresh(terminalId, turnId);
            }
            throw error;
        }
        this.log(record, 'continued', { manual: true });
    }

    start(watchHub: Pick<WatchHub, 'registerPoller'>, intervalMs = SWEEP_INTERVAL_MS): void {
        this.poller = watchHub.registerPoller({
            intervalMs,
            label: 'chat-usage-limit-waits',
            pollOnce: () => this.sweep(),
        });
    }

    async close(): Promise<void> {
        await this.poller?.dispose();
        this.poller = undefined;
        await this.sweeping;
    }

    /**
     * One pass over the waits; a pass still running absorbs the next tick.
     */
    async sweep(): Promise<void> {
        if (this.sweeping) return this.sweeping;
        this.sweeping = this.runSweep();
        try {
            await this.sweeping;
        } finally {
            this.sweeping = undefined;
        }
    }
}
