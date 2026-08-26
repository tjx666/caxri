import type { AgentOutputRecoverySettings, AgentProvider } from '@caxri/protocol';

import type { StructuredLogger } from '../../shared/node/logger';
import { logEventCatalog } from '../../shared/node/logger';
import type { TerminalTextTail } from './screen';

const MAXIMUM_TAIL_CHARACTERS = 4_096;
const MAXIMUM_RECOVERIES_PER_WINDOW = 3;
const RECOVERY_WINDOW_MS = 10 * 60 * 1_000;
const ESCAPE = '\u{1B}';
const CONTINUE = 'continue\r';

type RecoveryPhase = 'idle' | 'settling' | 'waiting-continue';
type RecoveryCancelReason = 'disposed' | 'settings-changed' | 'user-input';

type AgentOutputRecoveryStatus = 'recovered' | 'rate-limited';

export interface AgentOutputRecoveryOptions {
    terminalId: string;
    provider: AgentProvider;
    logger: StructuredLogger;
    getSettings: () => AgentOutputRecoverySettings;
    isCurrent: () => boolean;
    readTail: (maximumCharacters: number) => Promise<TerminalTextTail>;
    write: (data: string) => boolean;
    onStatus: (status: AgentOutputRecoveryStatus) => void;
    now?: () => number;
}

interface MatchingRule {
    index: number;
    pattern: string;
}

/**
 * Cursor chrome is provider-owned output syntax. A new provider must explicitly choose a reviewed omission pattern or
 * `undefined`; it must never inherit Claude Code's matcher.
 */
const CURSOR_LINE_OMISSION_PATTERNS: Record<AgentProvider, RegExp | undefined> = {
    claude: /^[^a-z\d]*cogitated for (?:\d+\s*[hms]\s*)+$/iu,
    codex: undefined,
};

function settingsSignature(settings: AgentOutputRecoverySettings): string {
    return JSON.stringify(settings);
}

function matchingRule(
    tail: TerminalTextTail,
    patterns: readonly string[],
    provider: AgentProvider,
): MatchingRule | undefined {
    const normalizedTails = [tail.full.trimEnd().toLowerCase()];
    /**
     * Claude Code leaves this completed duration chrome on the active cursor line after the preceding API error. Only
     * this narrow, content-free shape may be ignored; dropping an arbitrary cursor line could mistake historical errors
     * for the latest output while an Agent is visibly making progress.
     */
    if (CURSOR_LINE_OMISSION_PATTERNS[provider]?.test(tail.cursorLine.trim()))
        normalizedTails.push(tail.beforeCursorLine.trimEnd().toLowerCase());
    for (const [index, pattern] of patterns.entries()) {
        const normalizedPattern = pattern.trim().toLowerCase();
        if (
            normalizedPattern &&
            normalizedTails.some((normalizedTail) => normalizedTail.endsWith(normalizedPattern))
        )
            return { index, pattern: normalizedPattern };
    }
    return;
}

/**
 * One generation-scoped, opt-in recovery state machine. It observes only the Runtime's parsed Terminal tail and writes
 * fixed bytes to the exact live PTY supplied by its owner; output and user patterns never enter events or logs.
 */
export class AgentOutputRecovery {
    private attemptTimes: number[] = [];
    private disposed = false;
    private handledPattern?: string;
    private matchedRevision = -1;
    private outputRevision = 0;
    private phase: RecoveryPhase = 'idle';
    private timer?: NodeJS.Timeout;
    private readonly now: () => number;

    constructor(private readonly options: AgentOutputRecoveryOptions) {
        this.now = options.now ?? Date.now;
    }

    private currentSettings(signature?: string): AgentOutputRecoverySettings | undefined {
        const settings = this.options.getSettings();
        if (
            !settings.enabled ||
            settings.patterns.length === 0 ||
            (signature !== undefined && settingsSignature(settings) !== signature)
        )
            return;
        return settings;
    }

    private isEvaluationCurrent(revision: number): boolean {
        return (
            !this.disposed &&
            this.phase === 'settling' &&
            revision === this.outputRevision &&
            this.options.isCurrent()
        );
    }

    private scheduleSettle(): void {
        const settings = this.currentSettings();
        if (!settings) {
            this.clearTimer();
            this.phase = 'idle';
            return;
        }
        this.clearTimer();
        this.phase = 'settling';
        const revision = this.outputRevision;
        const signature = settingsSignature(settings);
        this.timer = setTimeout(async () => {
            this.timer = undefined;
            try {
                await this.evaluate(revision, signature);
            } catch {
                this.options.logger.write(
                    'warn',
                    logEventCatalog.pty.outputRecoveryEvaluateFailed,
                    {
                        fields: {
                            terminalId: this.options.terminalId,
                            provider: this.options.provider,
                        },
                    },
                );
            }
        }, settings.settleDelayMs);
        this.timer.unref();
    }

    private async evaluate(revision: number, signature: string): Promise<void> {
        if (!this.isEvaluationCurrent(revision)) return;
        const settings = this.currentSettings(signature);
        if (!settings) {
            this.phase = 'idle';
            return;
        }
        let tail: TerminalTextTail;
        try {
            tail = await this.options.readTail(MAXIMUM_TAIL_CHARACTERS);
        } catch {
            this.phase = 'idle';
            this.options.logger.write('warn', logEventCatalog.pty.outputRecoveryTailFailed, {
                fields: { terminalId: this.options.terminalId, provider: this.options.provider },
            });
            return;
        }
        if (!this.isEvaluationCurrent(revision) || !this.currentSettings(signature)) return;
        const rule = matchingRule(tail, settings.patterns, this.options.provider);
        if (!rule) {
            this.handledPattern = undefined;
            this.phase = 'idle';
            return;
        }
        if (this.handledPattern === rule.pattern) {
            this.phase = 'idle';
            return;
        }
        this.handledPattern = rule.pattern;
        this.matchedRevision = revision;
        const now = this.now();
        this.attemptTimes = this.attemptTimes.filter(
            (attempt) => now - attempt < RECOVERY_WINDOW_MS,
        );
        if (this.attemptTimes.length >= MAXIMUM_RECOVERIES_PER_WINDOW) {
            this.phase = 'idle';
            this.options.logger.write('warn', logEventCatalog.pty.outputRecoveryRateLimited, {
                fields: {
                    terminalId: this.options.terminalId,
                    provider: this.options.provider,
                    recoveryCount: this.attemptTimes.length,
                },
            });
            this.options.onStatus('rate-limited');
            return;
        }
        this.attemptTimes.push(now);
        if (!this.options.write(ESCAPE)) {
            this.phase = 'idle';
            return;
        }
        this.phase = 'waiting-continue';
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.sendContinue(signature, rule.index);
        }, settings.continueDelayMs);
        this.timer.unref();
    }

    private sendContinue(signature: string, ruleIndex: number): void {
        if (
            this.disposed ||
            this.phase !== 'waiting-continue' ||
            !this.options.isCurrent() ||
            !this.currentSettings(signature)
        ) {
            this.phase = 'idle';
            return;
        }
        this.rearmFromOutputAfterEscape(signature);
        this.phase = 'idle';
        if (!this.options.write(CONTINUE)) return;
        this.options.logger.write('info', logEventCatalog.pty.outputRecoveryCompleted, {
            fields: {
                terminalId: this.options.terminalId,
                provider: this.options.provider,
                ruleIndex,
            },
        });
        this.options.onStatus('recovered');
    }

    /**
     * Enqueues a parsed-screen barrier before Continue can produce new output. If Escape already exposed a genuinely
     * non-matching prompt or progress line, the same rule may recover a later failure; a redraw of the same error (or
     * Claude's duration chrome) keeps the fingerprint handled.
     */
    private rearmFromOutputAfterEscape(signature: string): void {
        if (this.outputRevision === this.matchedRevision || !this.handledPattern) return;
        const handledPattern = this.handledPattern;
        // Fire-and-forget from the timer callback: the parsed-screen barrier owns its own rejection path below.
        // eslint-disable-next-line no-void -- asynchronous re-arm must not delay the fixed Continue timer
        void this.options
            .readTail(MAXIMUM_TAIL_CHARACTERS)
            .then((tail) => {
                const settings = this.currentSettings(signature);
                if (!settings || !this.options.isCurrent()) return;
                const rule = matchingRule(tail, settings.patterns, this.options.provider);
                if (rule?.pattern === handledPattern) return;
                if (this.handledPattern === handledPattern) this.handledPattern = undefined;
            })
            .catch(() => {
                this.options.logger.write(
                    'warn',
                    logEventCatalog.pty.outputRecoveryRearmTailFailed,
                    {
                        fields: {
                            terminalId: this.options.terminalId,
                            provider: this.options.provider,
                        },
                    },
                );
            });
    }

    private cancel(reason: RecoveryCancelReason): void {
        const previousPhase = this.phase;
        this.clearTimer();
        this.phase = 'idle';
        if (previousPhase === 'idle' || reason === 'disposed') return;
        this.options.logger.write('info', logEventCatalog.pty.outputRecoveryCancelled, {
            fields: {
                terminalId: this.options.terminalId,
                provider: this.options.provider,
                phase: previousPhase,
                reason,
            },
        });
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    observeOutput(): void {
        if (this.disposed) return;
        this.outputRevision += 1;
        /**
         * Output after Escape is expected while the Agent returns to its prompt. Only human input, settings changes, or
         * generation retirement may cancel the already-authorized Continue step.
         */
        if (this.phase === 'waiting-continue') return;
        this.scheduleSettle();
    }

    observeUserInput(): void {
        this.cancel('user-input');
    }

    settingsChanged(): void {
        if (this.disposed) return;
        this.cancel('settings-changed');
        this.handledPattern = undefined;
        this.scheduleSettle();
    }

    dispose(): void {
        if (this.disposed) return;
        this.cancel('disposed');
        this.disposed = true;
    }
}
