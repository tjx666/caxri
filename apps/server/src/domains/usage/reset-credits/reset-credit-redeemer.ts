import type {
    AgentProvider,
    UsageLimit,
    UsageResetCreditOutcome,
    UsageResetCredits,
} from '@caxri/protocol';
import { isResetCreditRedeemable } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

type PlanLimitReading = Omit<UsageLimit, 'provider'>;

/**
 * Codex's own answers to a consume request (`ConsumeAccountRateLimitResetCreditOutcome`).
 */
type ConsumeAnswer = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

export interface ResetCreditRedeemerOptions {
    logger: StructuredLogger;
    now: () => number;
    /**
     * A fresh plan reading from the Terminal's running Codex Chat; undefined when no Chat answers, rejects on a failed
     * request.
     */
    readLimits: (terminalId: string) => Promise<PlanLimitReading | undefined>;
    /**
     * Whether the Terminal runs an open Codex Chat, checked before any read so another provider's windows are never
     * recorded as Codex's.
     */
    canConsume: (terminalId: string) => boolean;
    /**
     * Sends the consume request through the same Chat; undefined when no open Chat can send it, rejects when Codex does
     * not confirm.
     */
    consume: (terminalId: string, idempotencyKey: string) => Promise<ConsumeAnswer> | undefined;
    /**
     * Where a fresh reading lands, so every Client sees the spent credit and the reset windows on its next poll.
     */
    observer: {
        observeLimits(limits: UsageLimit[]): void;
        observeResetCredits(provider: AgentProvider, credits: UsageResetCredits | undefined): void;
    };
}

/**
 * Spends a Codex banked reset on the user's confirmation and nothing else. Spending is irreversible, so it is guarded
 * three ways. The account's credits and plan windows are read fresh and must still qualify
 * ({@link isResetCreditRedeemable}), because the Client's reading may be minutes old. Each user confirmation carries an
 * `attemptId` that becomes Codex's idempotency key, and one attempt runs at a time. An attempt Codex did not confirm
 * (timeout, dropped connection) is remembered: a retry with the same `attemptId` sends the same key, so a request that
 * did land answers `alreadyRedeemed` instead of spending again. The retry still rechecks the windows: a request that
 * landed has reset them, and so may the window's own reset since, so a retry that no longer qualifies answers
 * `notEligible` rather than risk spending a credit nothing needs; the fresh reading shows whether one was spent.
 */
export class ResetCreditRedeemer {
    private isRunning = false;
    private unconfirmedAttempt?: string;

    constructor(private readonly options: ResetCreditRedeemerOptions) {}

    /**
     * A fresh reading, kept as the newest one; undefined when the Chat cannot answer.
     */
    private async read(terminalId: string): Promise<PlanLimitReading | undefined> {
        const { observer } = this.options;
        try {
            const reading = await this.options.readLimits(terminalId);
            if (!reading) return undefined;
            observer.observeLimits([{ provider: 'codex', ...reading }]);
            observer.observeResetCredits('codex', reading.resetCredits);
            return reading;
        } catch {
            return undefined;
        }
    }

    private async run(
        terminalId: string,
        attemptId: string,
        isRetry: boolean,
    ): Promise<UsageResetCreditOutcome> {
        if (!this.options.canConsume(terminalId)) return 'unavailable';
        const reading = await this.read(terminalId);
        if (!reading) return 'unavailable';
        const limit: UsageLimit = { provider: 'codex', ...reading };
        if (!isResetCreditRedeemable(limit, this.options.now())) {
            if (isRetry) this.unconfirmedAttempt = undefined;
            return 'notEligible';
        }
        const pending = this.options.consume(terminalId, attemptId);
        if (!pending) return 'unavailable';
        let answer: ConsumeAnswer;
        try {
            answer = await pending;
        } catch {
            this.unconfirmedAttempt = attemptId;
            return 'unconfirmed';
        }
        this.unconfirmedAttempt = undefined;
        if (answer === 'reset' || answer === 'alreadyRedeemed') {
            // The windows and the count changed; a fresh reading keeps the next poll from showing the spent credit
            // until the five-minute refresh. A failed read leaves the old reading for that refresh to correct.
            await this.read(terminalId);
        }
        return answer;
    }

    async redeem(terminalId: string, attemptId: string): Promise<UsageResetCreditOutcome> {
        if (this.isRunning) return 'unavailable';
        this.isRunning = true;
        const startedAt = this.options.now();
        let outcome: UsageResetCreditOutcome = 'unavailable';
        const isRetry = this.unconfirmedAttempt === attemptId;
        try {
            outcome = await this.run(terminalId, attemptId, isRetry);
            return outcome;
        } finally {
            this.isRunning = false;
            this.options.logger.write(
                outcome === 'unconfirmed' ? 'warn' : 'info',
                logEventCatalog.usage.resetCreditRedeem,
                {
                    fields: {
                        provider: 'codex',
                        outcome,
                        isRetry,
                        durationMs: this.options.now() - startedAt,
                    },
                },
            );
        }
    }
}
