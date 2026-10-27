import type {
    AgentChatFailureReason,
    ClaudeWindowBackgroundState,
    ClaudeWindowOutcome,
    ClaudeWindowState,
    ClaudeWindowUnavailableReason,
    ServerEvent,
} from '@caxri/protocol';
import { CaxriError, DEFAULT_FIRST_WORKDAY_RESET_MINUTES } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { AgentChatStartError } from '../agent-chat';
import type { CaxriDatabase, ClaudeWindowSchedule } from '../db';
import { ClaudeWindowSchedulesModel } from '../db';
import type { ClaudeAccountReading, ClaudeWindowSession, OpenClaudeWindowSession } from './probe';
import type { KeeperDecision } from './schedule';
import { dailyWakeTimes, decide, nextAnchor, nextCheckAt, WINDOW_MS } from './schedule';

/**
 * How long a status read reuses the last reading before asking Claude Code again.
 */
const STATUS_REFRESH_MS = 60_000;

/**
 * The longest the in-process timer waits between checks of an enabled account, so a window a real request started
 * elsewhere is noticed and followed. Each check starts one short-lived Claude process and sends no model request.
 */
const MAX_CHECK_DELAY_MS = 60 * 60_000;

/**
 * The first check after Server Core starts, late enough to stay off the startup path. It discovers a new Pro account
 * (on by default) and reconciles at most once whatever the keeper missed while Caxri was closed.
 */
const STARTUP_CHECK_DELAY_MS = 60_000;

/**
 * Reads after the minimal request that look for the new window's reset; a window that has not appeared by the last one
 * is `trigger_unverified` and is never retried for the same planned time.
 */
const CONFIRMATION_DELAYS_MS = [0, 5_000, 25_000] as const;

/**
 * The anonymous account key: enough of the identity hash to tell accounts apart in the UI and logs.
 */
const ACCOUNT_KEY_LENGTH = 16;

type CheckSource = 'timer' | 'background' | 'status' | 'update';

export interface ClaudeWindowServiceOptions {
    database: CaxriDatabase;
    logger: StructuredLogger;
    send(event: ServerEvent): void;
    openSession: OpenClaudeWindowSession;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /**
     * Runs the startup check and the in-process timer. Off in E2E and unit tests, which drive checks explicitly.
     */
    isTimerEnabled: boolean;
}

/**
 * Keeps the signed-in Claude account's 5-hour windows rolling: at the morning anchor (`First workday reset at` minus
 * five hours) it starts a window with one minimal request, renews each window when it resets as long as the renewal
 * ends by the next anchor, and lets a real request's window stand instead of sending its own. Every check reads the
 * account and its windows fresh from a short-lived Claude Code process and fails closed on any doubt about the billing
 * path. See `docs/claude-windows.md`.
 *
 * Settings and schedule are keyed by the account identity hash, so a second account later gets its own row; today
 * Claude Code has one signed-in account, which is the one checked.
 */
export class ClaudeWindowService {
    private readonly schedules: ClaudeWindowSchedulesModel;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private background: ClaudeWindowBackgroundState = 'unknown';
    private state: ClaudeWindowState | undefined;
    private accountHash: string | undefined;
    private checking: Promise<ClaudeWindowState> | undefined;
    private timer: NodeJS.Timeout | undefined;
    private isTriggering = false;
    private isClosed = false;

    constructor(private readonly options: ClaudeWindowServiceOptions) {
        this.schedules = new ClaudeWindowSchedulesModel(options.database.database);
        this.now = options.now ?? Date.now;
        this.sleep =
            options.sleep ??
            ((ms) =>
                new Promise((resolve) => {
                    setTimeout(resolve, ms).unref();
                }));
        if (options.isTimerEnabled) this.schedule(this.now() + STARTUP_CHECK_DELAY_MS);
    }

    /**
     * One check at a time; a request that arrives during one shares its result.
     */
    private check(source: CheckSource): Promise<ClaudeWindowState> {
        if (this.checking) return this.checking;
        const checking = (async () => {
            try {
                return await this.runCheck(source);
            } finally {
                this.checking = undefined;
            }
        })();
        this.checking = checking;
        return checking;
    }

    private async runCheck(source: CheckSource): Promise<ClaudeWindowState> {
        const startedAt = this.now();
        let session: ClaudeWindowSession | undefined;
        let result: CheckResult;
        try {
            session = await this.options.openSession();
            result = await this.decideAndAct(session, source !== 'status');
        } catch (error) {
            result = {
                state: this.unavailable(
                    error instanceof AgentChatStartError && error.reason === 'executable_not_found'
                        ? 'claudeNotFound'
                        : 'probeFailed',
                ),
                decision: 'failed',
                failure: error instanceof AgentChatStartError ? error.reason : 'unexpected',
            };
        } finally {
            this.isTriggering = false;
            try {
                await session?.close();
            } catch {
                // Closing a finished probe process has nothing left to report.
            }
        }
        this.state = result.state;
        this.options.logger.write('info', logEventCatalog.claudeWindow.checked, {
            fields: {
                source,
                decision: result.decision,
                status: result.state.status,
                ...(result.state.reason && { reason: result.state.reason }),
                ...(result.failure && { failure: result.failure }),
                ...(result.plannedAt !== undefined && {
                    plannedAt: result.plannedAt,
                    lateMs: Math.max(0, startedAt - result.plannedAt),
                }),
                durationMs: this.now() - startedAt,
            },
        });
        this.changed();
        this.scheduleAfter(result.state);
        return this.withBackground(result.state);
    }

    private async decideAndAct(
        session: ClaudeWindowSession,
        canTrigger: boolean,
    ): Promise<CheckResult> {
        const probe = await session.read();
        if (!probe.ok) {
            if (probe.reason === 'authUnsupported') this.logOutcome('auth_unsupported', {});
            return { state: this.unavailable(probe.reason), decision: 'unavailable' };
        }
        const { reading } = probe;
        this.accountHash = reading.identity;
        const schedule: ClaudeWindowSchedule = {
            ...this.schedules.get(reading.identity),
            accountHash: reading.identity,
            planType: reading.planType,
            ...(reading.windowResetsAt !== undefined && {
                observedResetAt: reading.windowResetsAt,
            }),
        };
        if (!isEnabled(schedule)) {
            this.schedules.save(schedule);
            return { state: this.stateOf(schedule, reading, 'off'), decision: 'off' };
        }
        const firstReset = firstWorkdayReset(schedule);
        const now = this.now();
        const decision = decide(now, firstReset, reading, schedule);
        const plannedAt =
            'due' in decision
                ? decision.due.plannedAt
                : decision.kind === 'active'
                  ? decision.naturalFor?.plannedAt
                  : undefined;
        if (decision.kind === 'active' && decision.naturalFor) {
            schedule.processedThroughAt = decision.naturalFor.plannedAt;
            this.record(schedule, 'natural_window_started', decision.naturalFor.plannedAt);
        } else if (decision.kind === 'skipRenewal') {
            schedule.processedThroughAt = decision.due.plannedAt;
            this.record(schedule, 'renewal_skipped', decision.due.plannedAt);
        } else if (canTrigger && decision.kind === 'weeklyLimit') {
            this.record(schedule, 'weekly_limit', decision.due.plannedAt);
        }
        if (!canTrigger || decision.kind !== 'trigger') {
            this.schedules.save(schedule);
            const status =
                reading.isWeeklyLimitReached && decision.kind !== 'active'
                    ? 'unavailable'
                    : statusOf(decision, schedule);
            return {
                state: this.stateOf(schedule, reading, status),
                decision: decision.kind,
                ...(plannedAt !== undefined && { plannedAt }),
            };
        }
        return this.trigger(session, schedule, reading, decision.due);
    }

    /**
     * Spends the due window before sending, so a crash or a second check can never send for it again, then sends the
     * minimal request and looks for the new window's reset. A process that exits cleanly proves nothing on its own.
     */
    private async trigger(
        session: ClaudeWindowSession,
        schedule: ClaudeWindowSchedule,
        reading: ClaudeAccountReading,
        due: Extract<KeeperDecision, { kind: 'trigger' }>['due'],
    ): Promise<CheckResult> {
        schedule.processedThroughAt = due.plannedAt;
        this.schedules.save(schedule);
        this.isTriggering = true;
        this.state = this.stateOf(schedule, reading, 'triggering');
        this.changed();
        const sentAt = this.now();
        const isSent = await session.trigger();
        let confirmedReset: number | undefined;
        let confirmationReads = 0;
        for (const delay of CONFIRMATION_DELAYS_MS) {
            if (!isSent || this.isClosed) break;
            // Confirmation reads are spaced in time and stop at the first new reset, so they run one after another.
            // eslint-disable-next-line no-await-in-loop -- see above
            if (delay > 0) await this.sleep(delay);
            confirmationReads += 1;
            // eslint-disable-next-line no-await-in-loop -- see above
            const after = await session.read();
            if (
                after.ok &&
                after.reading.identity === reading.identity &&
                after.reading.windowResetsAt
            ) {
                confirmedReset = after.reading.windowResetsAt;
                break;
            }
        }
        this.isTriggering = false;
        const outcome: ClaudeWindowOutcome =
            confirmedReset !== undefined
                ? 'trigger_confirmed'
                : isSent
                  ? 'trigger_unverified'
                  : 'trigger_failed';
        if (confirmedReset !== undefined) {
            schedule.observedResetAt = confirmedReset;
            schedule.triggeredResetAt = confirmedReset;
        }
        if (due.isMissed)
            this.logOutcome('missed_while_asleep', {
                plannedAt: due.plannedAt,
                accountHash: schedule.accountHash,
            });
        this.record(schedule, outcome, due.plannedAt, {
            reason: due.reason,
            confirmationReads,
            ...(confirmedReset !== undefined && { resetInMs: confirmedReset - sentAt }),
            ...(due.isMissed && { missed: true }),
        });
        if (due.isMissed && schedule.lastOutcome)
            schedule.lastOutcome.missedPlannedAt = due.plannedAt;
        this.schedules.save(schedule);
        const updated = {
            ...reading,
            ...(confirmedReset !== undefined && { windowResetsAt: confirmedReset }),
        };
        return {
            state: this.stateOf(
                schedule,
                updated,
                confirmedReset !== undefined ? 'confirmed' : 'waitingForAnchor',
            ),
            decision: 'trigger',
            plannedAt: due.plannedAt,
        };
    }

    private record(
        schedule: ClaudeWindowSchedule,
        outcome: ClaudeWindowOutcome,
        plannedAt: number,
        fields: Record<string, string | number | boolean> = {},
    ): void {
        schedule.lastOutcome = { outcome, at: this.now() };
        this.logOutcome(outcome, {
            accountHash: schedule.accountHash,
            plannedAt,
            ...(schedule.planType && { planType: schedule.planType }),
            ...fields,
        });
    }

    private logOutcome(
        outcome: ClaudeWindowOutcome,
        {
            accountHash,
            ...fields
        }: { accountHash?: string } & Record<string, string | number | boolean | undefined>,
    ): void {
        this.options.logger.write(
            outcome.startsWith('trigger_f') ? 'warn' : 'info',
            logEventCatalog.claudeWindow.outcome,
            {
                fields: {
                    outcome,
                    ...(accountHash && { account: accountKey(accountHash) }),
                    ...fields,
                },
            },
        );
    }

    private stateOf(
        schedule: ClaudeWindowSchedule,
        reading: ClaudeAccountReading,
        status: ClaudeWindowState['status'],
    ): ClaudeWindowState {
        const now = this.now();
        const isKeeperEnabled = isEnabled(schedule);
        const firstReset = firstWorkdayReset(schedule);
        const anchor = nextAnchor(now, firstReset);
        return {
            account: {
                key: accountKey(schedule.accountHash),
                ...(schedule.planType && { planType: schedule.planType }),
                keepRolling: isKeeperEnabled,
                keepRollingIsDefault: schedule.keepRolling === undefined,
                firstWorkdayResetMinutes: firstReset,
            },
            status,
            ...(status === 'unavailable' && { reason: 'weeklyLimit' as const }),
            ...(reading.windowResetsAt !== undefined && { windowResetsAt: reading.windowResetsAt }),
            ...(isKeeperEnabled && {
                nextAnchorAt: anchor,
                nextWorkdayResetAt: anchor + WINDOW_MS,
            }),
            ...(schedule.lastOutcome && { lastOutcome: schedule.lastOutcome }),
            background: this.background,
            checkedAt: now,
            wakeTimes: isKeeperEnabled ? dailyWakeTimes(firstReset) : [],
        };
    }

    /**
     * A paused keeper keeps showing the last known account and its settings, so a transient failure does not hide them.
     */
    private unavailable(reason: ClaudeWindowUnavailableReason): ClaudeWindowState {
        return {
            ...(this.state?.account && { account: this.state.account }),
            status: 'unavailable',
            reason,
            ...(this.state?.lastOutcome && { lastOutcome: this.state.lastOutcome }),
            background: this.background,
            checkedAt: this.now(),
            wakeTimes: this.state?.wakeTimes ?? [],
        };
    }

    private withBackground(state: ClaudeWindowState): ClaudeWindowState {
        return {
            ...state,
            background: this.background,
            ...(this.isTriggering && { status: 'triggering' }),
        };
    }

    private changed(): void {
        this.options.send({ event: 'claudeWindow.changed', payload: {} });
    }

    private scheduleAfter(state: ClaudeWindowState): void {
        if (!this.options.isTimerEnabled || this.isClosed) return;
        const account = state.account;
        // A check that never identified the account (Claude Code missing, offline at login) tries again later, so a
        // keeper that is on by default still starts without the user opening Settings.
        if (!account) {
            this.schedule(this.now() + MAX_CHECK_DELAY_MS);
            return;
        }
        if (!account.keepRolling) {
            clearTimeout(this.timer);
            this.timer = undefined;
            return;
        }
        this.schedule(
            nextCheckAt(
                this.now(),
                account.firstWorkdayResetMinutes,
                state.windowResetsAt,
                MAX_CHECK_DELAY_MS,
            ),
        );
    }

    private schedule(at: number): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(
            () => {
                void this.check('timer');
            },
            Math.max(0, at - this.now()),
        );
        // The timer never keeps Server Core alive; the background job wakes it while Caxri is closed.
        this.timer.unref();
    }

    async status(shouldRefresh: boolean): Promise<ClaudeWindowState> {
        if (
            !shouldRefresh &&
            this.state?.checkedAt !== undefined &&
            this.now() - this.state.checkedAt < STATUS_REFRESH_MS
        )
            return this.withBackground(this.state);
        return this.check('status');
    }

    async update(parameters: {
        accountKey: string;
        keepRolling?: boolean;
        firstWorkdayResetMinutes?: number;
    }): Promise<ClaudeWindowState> {
        // A running check saves the schedule it read before this change, so the change waits for it to finish.
        // Each wait ends one check; another may start before this resumes.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- see above
        while (this.checking) await this.checking; // eslint-disable-line no-await-in-loop -- see above
        const hash = this.accountHash;
        if (!hash || accountKey(hash) !== parameters.accountKey)
            throw new CaxriError(
                'CONFLICT',
                'The signed-in Claude account changed; reload its settings',
            );
        const schedule = this.schedules.get(hash) ?? { accountHash: hash };
        this.schedules.save({
            ...schedule,
            ...(parameters.keepRolling !== undefined && { keepRolling: parameters.keepRolling }),
            ...(parameters.firstWorkdayResetMinutes !== undefined && {
                firstWorkdayResetMinutes: parameters.firstWorkdayResetMinutes,
            }),
        });
        return this.check('update');
    }

    tick(): Promise<ClaudeWindowState> {
        return this.check('background');
    }

    reportBackground(state: ClaudeWindowBackgroundState): void {
        if (this.background === state) return;
        this.background = state;
        this.changed();
    }

    shutdown(): void {
        this.isClosed = true;
        clearTimeout(this.timer);
    }
}

interface CheckResult {
    state: ClaudeWindowState;
    decision: KeeperDecision['kind'] | 'off' | 'unavailable' | 'failed';
    /**
     * Why Claude Code could not be started or read: the Chat launch's closed failure reason, or `unexpected`.
     */
    failure?: AgentChatFailureReason | 'unexpected';
    plannedAt?: number;
}

function accountKey(hash: string): string {
    return hash.slice(0, ACCOUNT_KEY_LENGTH);
}

/**
 * The user's explicit choice, or the plan default: on for Pro, off for Max and every other plan.
 */
function isEnabled(schedule: ClaudeWindowSchedule): boolean {
    return schedule.keepRolling ?? schedule.planType === 'pro';
}

function firstWorkdayReset(schedule: ClaudeWindowSchedule): number {
    return schedule.firstWorkdayResetMinutes ?? DEFAULT_FIRST_WORKDAY_RESET_MINUTES;
}

function statusOf(
    decision: KeeperDecision,
    schedule: ClaudeWindowSchedule,
): ClaudeWindowState['status'] {
    switch (decision.kind) {
        case 'active': {
            if (schedule.triggeredResetAt === decision.resetsAt) return 'confirmed';
            return decision.renews ? 'windowActive' : 'waitingForNaturalReset';
        }
        case 'weeklyLimit': {
            return 'unavailable';
        }
        default: {
            return 'waitingForAnchor';
        }
    }
}
