import type { AgentDelegationReceipt } from '@caxri/protocol';
import { normalizeTerminalTitle } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentCoordinator, AgentLifecycleSignal } from '../agents';
import type { CaxriDatabase } from '../db';
import type { TerminalManager } from '../terminal';

/**
 * How a delegation's terminal transition reads in the Commander Terminal. `needsInput` covers both a startup prompt
 * (`startup_waiting`) and an in-task permission request (`permission_required`): both need the user's hands, and the
 * board already groups both under `attention` for the same reason.
 */
export type CommanderCompletionNoticeStatus = 'completed' | 'failed' | 'needsInput';

export interface CommanderCompletionNoticeEntry {
    delegationId: string;
    sessionId: string;
    status: CommanderCompletionNoticeStatus;
}

/**
 * Why a consumed notice batch's PTY write did not provably land. Both are rare: the Commander Terminal was just
 * confirmed idle and on its current generation a moment earlier in the same synchronous call.
 */
export type CommanderCompletionNoticeDeliveryFailure = 'rejected' | 'unconfirmed';

/**
 * Why pending notices were discarded without ever being written. Pending notices live only in Server Core memory, so a
 * Server shutdown is the one path that loses them; logging it keeps "the Commander never heard back" answerable.
 */
type CommanderCompletionNoticeDropReason = 'server_shutdown';

/**
 * Which delivery gate is holding the pending notices back. Logged once per change for the current batch, so a report
 * that the Commander "never heard back" names the gate without logging every lifecycle signal.
 */
export type CommanderCompletionNoticeDeferral =
    /**
     * The Terminal the notice would go to is not the recorded Commander Terminal.
     */
    | 'not_commander_terminal'
    /**
     * No finished turn is proven idle yet: the Commander is mid-turn, or its last turn was already used by a notice.
     */
    | 'commander_busy'
    /**
     * The finished turn has no recorded start, or started on another launch.
     */
    | 'turn_baseline_missing'
    /**
     * Someone typed into the Commander since its turn started and did not submit it; delivering would press Enter on
     * their draft.
     */
    | 'draft_input'
    /**
     * The Commander is waiting on a permission prompt.
     */
    | 'awaiting_permission';

const STATUS_LABEL: Record<CommanderCompletionNoticeStatus, string> = {
    completed: 'completed',
    failed: 'failed',
    needsInput: 'needs your input',
};

/**
 * Flattens a value this module writes into the Commander Terminal to one control-character-free line, reusing the same
 * flatten/sanitize/cap `normalizeTerminalTitle` already applies to untrusted PTY and Agent-reported titles
 * (`packages/protocol/src/domain/terminal-title.ts`). Belt-and-suspenders here: these values already come from
 * validated records, but this text becomes literal PTY input, a stronger trust boundary than a JSON field, and an empty
 * identifier must still render as something rather than silently disappearing from the line.
 */
function sanitizeSingleLine(value: string): string {
    return normalizeTerminalTitle(value) ?? '?';
}

/**
 * Classifies a delegation receipt into the notice it should raise, or `undefined` when the transition is not one the
 * Commander needs pushed to it (an in-flight status, a human takeover, or an interrupted/stopped task the Commander
 * itself did not ask to stop through a follow-up).
 */
export function classifyCommanderCompletionNotice(
    receipt: Pick<AgentDelegationReceipt, 'failure' | 'status'>,
): CommanderCompletionNoticeStatus | undefined {
    if (receipt.status === 'completed') return 'completed';
    if (receipt.status === 'failed' || receipt.status === 'answer_unavailable') return 'failed';
    if (
        receipt.status === 'blocked' &&
        (receipt.failure === 'startup_waiting' || receipt.failure === 'permission_required')
    )
        return 'needsInput';
    return undefined;
}

/**
 * Builds the single injected line for one or more coalesced transitions. Content is Server-generated only: a delegation
 * ID, a Session ID, and a closed status word, never a transcript or Agent-authored text. Multiple pending transitions
 * join into this one line instead of one injection per delegation, so a Commander that was busy through several
 * completions still receives exactly one line to read.
 */
export function formatCommanderCompletionNotice(
    entries: readonly CommanderCompletionNoticeEntry[],
): string {
    const clauses = entries.map(
        (entry) =>
            `delegation ${sanitizeSingleLine(entry.delegationId)} in Session ${sanitizeSingleLine(
                entry.sessionId,
            )} ${STATUS_LABEL[entry.status]}`,
    );
    const summary =
        entries.length === 1 ? '1 delegation update' : `${entries.length} delegation updates`;
    return `[Caxri notice] ${summary}: ${clauses.join('; ')}.`;
}

export interface CommanderCompletionNotifierOptions {
    database: Pick<CaxriDatabase, 'agentCommanderRows' | 'getSession'>;
    /**
     * The same idle proof delegation follow-ups fence resume against (`AgentCoordinator.hasIdleProof`,
     * `apps/server/src/domains/agent-delegation/service.ts`). Proves the exact launch and turn actually finished; it
     * says nothing about a later draft, which the input-epoch check below covers.
     */
    hasIdleProof(terminalId: string, launchId: string, turnId: string): boolean;
    /**
     * `TerminalManager.inputEpoch`: bumps once per human keystroke written to the Terminal, but not for this module's
     * own injected write (see `write` below). Comparing it to the value captured at the finished turn's start is the
     * same fence `AgentDelegationService` uses before a follow-up resumes (`service.ts` ~260-300).
     */
    inputEpoch(terminalId: string): number;
    logger?: StructuredLogger;
    /**
     * Fenced exact-launch write. Must be called with `origin: 'delegation'` (`TerminalManager.writeAgentExact`) so the
     * injected line itself never bumps the input epoch and blocks a later notice's own fence.
     */
    write(
        terminalId: string,
        data: string,
        launchId: string,
        onDelivered?: (wasAccepted: boolean) => void,
    ): boolean;
}

/**
 * Pushes delegation completion, failure, and needs-input transitions into the Agent Commander Terminal as a bounded,
 * Server-generated system notice, so the Commander can report them without polling `agent delegate wait` in 300-second
 * rounds. This is a Server Core-owned exception to the peer-message rule: the text never comes from another Agent, and
 * it can never carry a permission, a setting change, or a slash command (see `docs/agent-messaging.md`).
 *
 * Delivery only ever happens through the exact same fence `AgentDelegationService` uses before resuming a follow-up:
 * the finished turn's idle proof, and an input epoch unchanged since that turn started, unless the last input since
 * then submitted its line (a steer or queued message leaves no draft behind). A draft typed mid-turn or after it, or a
 * pending attention/permission request, defers delivery to the next clean idle point instead of guessing whether Enter
 * is safe to send. The residual risk is the same in-flight-keystroke race every exact-launch write already accepts: a
 * keystroke sent in the same event-loop turn as the write, before its epoch bump is observed here, is not detectable.
 *
 * Pending notices live only in memory: a delegation transition consumed by a batch (see `tryFlush`) can never be sent
 * twice, and an undelivered batch waits through a Codex relaunch for the new launch's first clean turn, but it does not
 * survive a Server restart (`close` logs what that discards). `commander board` and the ledger the Commander keeps in
 * its workspace are the compensation for that loss, exactly as they already are for the pre-existing `agent delegate
 * wait` / board-polling path this feature supplements.
 */
export class CommanderCompletionNotifier {
    private readonly pending = new Map<string, CommanderCompletionNoticeEntry>();
    /**
     * Highest receipt revision already turned into a pending or delivered notice, per delegation. Guards against a
     * duplicate `notifyReceiptChanged` call re-queuing the same transition; `AgentDelegationService.save` already
     * filters most non-transitions, so this is a second, explicit line of defense at this module's own boundary.
     */
    private readonly notifiedRevisions = new Map<string, number>();
    /**
     * Input epoch recorded at the start of the Commander Terminal's current turn, keyed by that turn's launch ID.
     */
    private turnStartBaseline: { epoch: number; launchId: string } | undefined;
    /**
     * The most recently finished turn's identity, used to re-check the idle-proof fence when a new notice arrives while
     * the Commander is already idle (no new `turnFinished` signal will fire to trigger that check).
     */
    private lastFinishedTurn: { launchId: string; turnId: string } | undefined;
    /**
     * When the oldest pending notice was queued, for the delivered event's wait time.
     */
    private oldestPendingAt: number | undefined;
    /**
     * The deferral last logged for the current batch, so each gate change is logged once rather than per signal.
     */
    private loggedDeferral: CommanderCompletionNoticeDeferral | undefined;
    /**
     * The Commander Terminal's input epoch right after its last human input was a submitted line (a standalone Enter
     * outside a bracketed paste). While the epoch still equals it, the composer holds no draft: the last thing the user
     * did was send what they typed, as a mid-turn steer or a queued message (#1520).
     */
    private submittedEpoch: number | undefined;
    /**
     * Whether the Commander Terminal is inside a bracketed paste, whose Enter keys are part of the draft.
     */
    private isPasting = false;
    /**
     * Finished Commander turns that could not take the current batch. The deferral is logged once per gate change, so
     * without this count five consecutive turns held back by the same draft read as a single log line.
     */
    private blockedTurns = 0;

    constructor(private readonly options: CommanderCompletionNotifierOptions) {}

    private deferral(terminalId: string): CommanderCompletionNoticeDeferral | undefined {
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId || rows.terminalId !== terminalId) return 'not_commander_terminal';
        const finished = this.lastFinishedTurn;
        if (!finished || !this.options.hasIdleProof(terminalId, finished.launchId, finished.turnId))
            return 'commander_busy';
        const baseline = this.turnStartBaseline;
        if (!baseline || baseline.launchId !== finished.launchId) return 'turn_baseline_missing';
        const epoch = this.options.inputEpoch(terminalId);
        if (epoch !== baseline.epoch && epoch !== this.submittedEpoch) return 'draft_input';
        const session = this.options.database.getSession(rows.sessionId);
        /**
         * Only a pending permission/attention prompt blocks delivery. `hasUnread` is deliberately not a gate: every
         * settled Commander turn raises `completed` attention on its own Session, and nothing marks that Session read
         * because the Commander window is never a Workbench selection, so it would withhold every notice after the
         * Commander's first turn.
         */
        if (!session || session.lastActivityState === 'waiting') return 'awaiting_permission';
        return undefined;
    }

    private oldestPendingWaitMs(): number {
        return Math.round(performance.now() - (this.oldestPendingAt ?? performance.now()));
    }

    private resetBatch(): void {
        this.oldestPendingAt = undefined;
        this.loggedDeferral = undefined;
        this.blockedTurns = 0;
    }

    private reportDeliveryFailed(reason: CommanderCompletionNoticeDeliveryFailure): void {
        this.options.logger?.write(
            'warn',
            logEventCatalog.agentCommander.completionNoticeDeliveryFailed,
            { fields: { reason } },
        );
    }

    /**
     * Attempts to deliver every currently pending notice as one coalesced line. Returns without effect whenever a gate
     * is not satisfied yet: the ordinary path while the Commander is mid-turn, which resolves itself the next time a
     * turn settles or a new notice arrives. Each change of the holding gate is logged once per batch.
     */
    private tryFlush(terminalId: string, isTurnFinished = false): void {
        if (this.pending.size === 0) return;
        const deferral = this.deferral(terminalId);
        if (deferral) {
            if (isTurnFinished) this.blockedTurns += 1;
            if (deferral !== this.loggedDeferral) {
                this.loggedDeferral = deferral;
                this.options.logger?.write(
                    'debug',
                    logEventCatalog.agentCommander.completionNoticeDeferred,
                    {
                        fields: {
                            reason: deferral,
                            pendingCount: this.pending.size,
                            blockedTurns: this.blockedTurns,
                            ...(deferral === 'draft_input' && {
                                inputsSinceTurnStart: this.inputsSinceTurnStart(terminalId),
                            }),
                        },
                    },
                );
            }
            return;
        }
        const finished = this.lastFinishedTurn!;
        const entries = this.pending.values().toArray();
        /**
         * Consume before sending: even a write whose outcome is never confirmed must not be retried, so at-most-once
         * delivery holds regardless of what happens after this point. Mirrors `SessionCompaction.compact`'s own
         * consume-before-send comment for the identical reason.
         */
        this.pending.clear();
        const waitMs = this.oldestPendingWaitMs();
        const { blockedTurns } = this;
        this.resetBatch();
        /**
         * Also consume the finished-turn identity this flush just proved idle against. The write below never bumps
         * `inputEpoch` and does not invalidate `hasIdleProof`, so without this a second delegation reaching this method
         * a moment later (before Codex has actually started a fresh turn to process the line just injected) would pass
         * every fence check again and write a second time into a Terminal this module can no longer prove is still
         * idle. Clearing it here forces every later flush to wait for its own fresh `turnStarted` / `turnFinished`
         * pair, so at most one write happens per proven-idle turn.
         */
        this.lastFinishedTurn = undefined;
        const text = `${formatCommanderCompletionNotice(entries)}\r`;
        const accepted = this.options.write(terminalId, text, finished.launchId, (wasAccepted) => {
            if (!wasAccepted) this.reportDeliveryFailed('unconfirmed');
        });
        if (!accepted) this.reportDeliveryFailed('rejected');
        else
            this.options.logger?.write(
                'info',
                logEventCatalog.agentCommander.completionNoticeDelivered,
                { fields: { count: entries.length, waitMs, blockedTurns } },
            );
    }

    /**
     * Keystrokes counted since the finished turn started, for a `draft_input` deferral: a count, never the input.
     */
    private inputsSinceTurnStart(terminalId: string): number {
        return this.options.inputEpoch(terminalId) - (this.turnStartBaseline?.epoch ?? 0);
    }

    /**
     * Feeds every human input written to a Terminal, after its input epoch counted it. Only whether the input submitted
     * a line is kept; the text itself is never retained. A lone Enter outside a paste counts as a submission, so an
     * Enter that only accepted a completion popup and was the draft's last keystroke reads as submitted too: the TUI's
     * popup state is not visible here, and leaving the Commander silent after every steered message was the larger
     * harm.
     */
    observeInput(terminalId: string, data: string): void {
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId || rows.terminalId !== terminalId) return;
        if (data.includes('\u{1B}[200~')) this.isPasting = true;
        this.submittedEpoch =
            data === '\r' && !this.isPasting ? this.options.inputEpoch(terminalId) : undefined;
        if (data.includes('\u{1B}[201~')) this.isPasting = false;
    }

    /**
     * Feeds every lifecycle signal Server Core applies. Signals for a Terminal other than the current Commander
     * Terminal are ignored; a stopped or replaced Commander naturally stops matching once `agentCommanderRows` no
     * longer names that Terminal.
     */
    onLifecycleApplied(signal: AgentLifecycleSignal): void {
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId || rows.terminalId !== signal.terminalId) return;
        if (signal.phase === 'turnStarted') {
            this.turnStartBaseline = {
                epoch: this.options.inputEpoch(signal.terminalId),
                launchId: signal.launchId,
            };
            return;
        }
        if (signal.phase !== 'turnFinished' || !signal.agentTurnId) return;
        this.lastFinishedTurn = { launchId: signal.launchId, turnId: signal.agentTurnId };
        this.tryFlush(signal.terminalId, true);
    }

    /**
     * Records the batch a Server shutdown discards. Nothing is retried: the pending notices exist only in this process,
     * and the Commander recovers the same facts from `commander board` and its ledger after the restart.
     */
    close(): void {
        if (this.pending.size === 0) return;
        const reason: CommanderCompletionNoticeDropReason = 'server_shutdown';
        this.options.logger?.write('info', logEventCatalog.agentCommander.completionNoticeDropped, {
            fields: {
                reason,
                count: this.pending.size,
                waitMs: this.oldestPendingWaitMs(),
                blockedTurns: this.blockedTurns,
                lastDeferral: this.loggedDeferral ?? null,
            },
        });
        this.pending.clear();
        this.resetBatch();
    }

    /**
     * Feeds every delegation receipt change. Only a transition the Commander itself dispatched
     * (`receipt.callerTerminalId` is the Commander Terminal) into a Session it created is eligible; an external
     * delegation caller that happens to target a Commander Session is not this module's concern.
     */
    notifyReceiptChanged(receipt: AgentDelegationReceipt, previous?: AgentDelegationReceipt): void {
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId) return;
        if (receipt.callerTerminalId !== rows.terminalId) return;
        if (!rows.sessionIds.includes(receipt.sessionId)) return;
        const status = classifyCommanderCompletionNotice(receipt);
        if (!status) return;
        /**
         * A task that fails straight out of `requested` was refused at admission (`target_busy`, `target_not_ready`,
         * ...) inside the very `agent delegate create` call the Commander is still waiting on, so the CLI already
         * returned that failure. Pushing it again only queues a duplicate line behind the Commander's next turn.
         */
        if (status === 'failed' && previous?.status === 'requested') return;
        const notifiedRevision = this.notifiedRevisions.get(receipt.delegationId) ?? 0;
        if (receipt.revision <= notifiedRevision) return;
        this.notifiedRevisions.set(receipt.delegationId, receipt.revision);
        this.oldestPendingAt ??= performance.now();
        this.pending.set(receipt.delegationId, {
            delegationId: receipt.delegationId,
            sessionId: receipt.sessionId,
            status,
        });
        this.options.logger?.write('debug', logEventCatalog.agentCommander.completionNoticeQueued, {
            fields: {
                delegationId: receipt.delegationId,
                sessionId: receipt.sessionId,
                status,
                pendingCount: this.pending.size,
            },
        });
        this.tryFlush(rows.terminalId);
    }
}

/**
 * Binds the notifier to the Server's coordinator and Terminal manager. `write` fixes `origin: 'delegation'` so the
 * injected notice line itself never bumps the input epoch a later notice's own draft fence reads.
 */
export function createCommanderCompletionNotifier({
    coordinator,
    database,
    logger,
    terminals,
}: {
    coordinator: Pick<AgentCoordinator, 'hasIdleProof'>;
    database: CommanderCompletionNotifierOptions['database'];
    logger?: StructuredLogger;
    terminals: Pick<TerminalManager, 'inputEpoch' | 'writeAgentExact'>;
}): CommanderCompletionNotifier {
    return new CommanderCompletionNotifier({
        database,
        hasIdleProof: (terminalId, launchId, turnId) =>
            coordinator.hasIdleProof(terminalId, launchId, turnId),
        inputEpoch: (terminalId) => terminals.inputEpoch(terminalId),
        logger,
        write: (terminalId, data, launchId, onDelivered) =>
            terminals.writeAgentExact(terminalId, data, launchId, 'delegation', onDelivered),
    });
}
