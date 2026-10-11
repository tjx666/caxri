import type { AgentDelegationReceipt } from '@caxri/protocol';
import { isChatTerminal, normalizeTerminalTitle } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentChatService } from '../agent-chat';
import type { AgentCoordinator, AgentLifecycleSignal } from '../agents';
import type { CaxriDatabase, CommanderPendingNoticesModel, DeliveredNotice } from '../db';
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

/**
 * The line a relaunched Commander receives as its first prompt. It names what the Commander missed while it was not
 * running (a turn that never finished, delegations that settled), never what they produced, and tells it to reconcile
 * before acting. Server-generated only, like every notice.
 */
export function formatCommanderResumePrompt(
    entries: readonly CommanderCompletionNoticeEntry[],
    wasTurnInterrupted: boolean,
): string {
    const parts = ['[Caxri notice] The Agent Commander restarted.'];
    if (wasTurnInterrupted)
        parts.push(
            'Your previous turn did not finish: Caxri or Codex restarted, or the turn was interrupted. Continue it unless the user stopped it on purpose.',
        );
    if (entries.length > 0)
        parts.push(formatCommanderCompletionNotice(entries).replace('[Caxri notice] ', 'Missed '));
    parts.push(
        'Reconcile with `commander task list` and `commander board` before you act, then report under Reporting.',
    );
    return parts.join(' ');
}

export interface CommanderCompletionNotifierOptions {
    database: Pick<CaxriDatabase, 'agentCommanderRows' | 'getSession'> & {
        commanderPendingNotices: Pick<
            CommanderPendingNoticesModel,
            'clearTurn' | 'list' | 'markTurnStarted' | 'putDelegation' | 'removeDelegations'
        >;
    };
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
    now?: () => number;
    /**
     * Delivers one notice line, without a line terminator, to the Commander. A PTY Commander gets a fenced exact-launch
     * write with `origin: 'delegation'` (`TerminalManager.writeAgentExact`) so the injected line itself never bumps the
     * input epoch and blocks a later notice's own fence; a Chat Commander gets a Chat message.
     */
    write(
        terminalId: string,
        data: string,
        launchId: string,
        onDelivered?: (wasAccepted: boolean) => void,
    ): boolean;
}

/**
 * What the launch prompt built for one Commander launch carried, settled once that launch is running.
 */
interface LaunchPromptClaim {
    /**
     * When the prompt was built. A turn marker set after it belongs to the new launch, not the one this prompt resumed.
     */
    claimedAt: number;
    /**
     * The exact revisions the prompt reported; a newer transition that lands before the launch runs stays owed.
     */
    delegations: DeliveredNotice[];
    hasInterruptedTurn: boolean;
    oldestQueuedAt: number;
    terminalId: string;
}

/**
 * Pushes delegation completion, failure, and needs-input transitions into the Agent Commander Terminal as a bounded,
 * Server-generated system notice, so the Commander can report them without polling `agent delegate wait` in 300-second
 * rounds. This is a Server Core-owned exception to the peer-message rule: the text never comes from another Agent, and
 * it can never carry a permission, a setting change, or a slash command (see `docs/agent-messaging.md`).
 *
 * Delivery into a running Commander only ever happens through the exact same fence `AgentDelegationService` uses before
 * resuming a follow-up: the finished turn's idle proof, and an input epoch unchanged since that turn started, unless
 * the last input since then submitted its line (a steer or queued message leaves no draft behind). A draft typed
 * mid-turn or after it, or a pending attention/permission request, defers delivery to the next clean idle point instead
 * of guessing whether Enter is safe to send. The residual risk is the same in-flight-keystroke race every exact-launch
 * write already accepts: a keystroke sent in the same event-loop turn as the write, before its epoch bump is observed
 * here, is not detectable.
 *
 * Pending notices are persisted (`commander_pending_notices`), so a Server restart no longer loses them. A relaunched
 * Commander has no finished turn to prove idle against, so instead of waiting for the user to speak first it receives
 * what it missed as its launch prompt (`launchPrompt`), together with a marker for a Commander turn that started and
 * never finished. That path is at least once: the rows are settled when the launch reports running, so a Server crash
 * between spawn and that report repeats them on the next launch rather than losing them.
 */
export class CommanderCompletionNotifier {
    /**
     * Highest receipt revision already turned into a pending or delivered notice, per delegation. Guards against a
     * duplicate `notifyReceiptChanged` call re-queuing the same transition; `AgentDelegationService.save` already
     * filters most non-transitions, so this is a second, explicit line of defense at this module's own boundary. Seeded
     * from the persisted queue, so a restart cannot re-queue a transition that is still waiting.
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
    private launchClaim: LaunchPromptClaim | undefined;

    constructor(private readonly options: CommanderCompletionNotifierOptions) {
        for (const notice of options.database.commanderPendingNotices.list())
            if (notice.kind === 'delegation')
                this.notifiedRevisions.set(notice.delegationId, notice.revision);
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private pendingDelegations() {
        return this.options.database.commanderPendingNotices
            .list()
            .filter((notice) => notice.kind === 'delegation');
    }

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

    private resetBatch(): void {
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
        const pending = this.pendingDelegations();
        if (pending.length === 0) return;
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
                            pendingCount: pending.length,
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
        /**
         * Consume before sending: even a write whose outcome is never confirmed must not be retried, so at-most-once
         * delivery holds regardless of what happens after this point. Mirrors `SessionCompaction.compact`'s own
         * consume-before-send comment for the identical reason.
         */
        this.options.database.commanderPendingNotices.removeDelegations(pending);
        const waitMs = Math.max(0, this.now() - pending[0].queuedAt);
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
        const text = formatCommanderCompletionNotice(pending);
        const accepted = this.options.write(terminalId, text, finished.launchId, (wasAccepted) => {
            if (!wasAccepted) this.reportDeliveryFailed('unconfirmed');
        });
        if (!accepted) this.reportDeliveryFailed('rejected');
        else
            this.options.logger?.write(
                'info',
                logEventCatalog.agentCommander.completionNoticeDelivered,
                { fields: { count: pending.length, waitMs, blockedTurns } },
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
     * longer names that Terminal. A started turn is persisted until it finishes or fails, which is how the next launch
     * knows a restart cut one off.
     */
    onLifecycleApplied(signal: AgentLifecycleSignal): void {
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId || rows.terminalId !== signal.terminalId) return;
        /**
         * A subagent's turn is part of the Commander's own; only the main thread's turns mark or clear the marker.
         */
        const isMainThread = !signal.agentId;
        if (signal.phase === 'turnStarted') {
            if (isMainThread)
                this.options.database.commanderPendingNotices.markTurnStarted(this.now());
            this.turnStartBaseline = {
                epoch: this.options.inputEpoch(signal.terminalId),
                launchId: signal.launchId,
            };
            return;
        }
        if (signal.phase === 'turnFailed') {
            if (isMainThread) this.options.database.commanderPendingNotices.clearTurn();
            return;
        }
        if (signal.phase !== 'turnFinished' || !signal.agentTurnId) return;
        if (isMainThread) this.options.database.commanderPendingNotices.clearTurn();
        this.lastFinishedTurn = { launchId: signal.launchId, turnId: signal.agentTurnId };
        this.tryFlush(signal.terminalId, true);
    }

    /**
     * The first prompt for a Commander launch, built from what is still owed: a turn that never finished and the
     * delegation notices nobody delivered. Nothing is consumed here, because a resolved launch may never spawn;
     * `onLaunched` settles exactly what this prompt carried.
     */
    launchPrompt(terminalId: string): string | undefined {
        /**
         * Every Agent launch without its own first prompt asks, restores included. Another Terminal resolving while the
         * Commander's launch is still between this call and `onLaunched` must leave the Commander's claim alone.
         */
        if (this.options.database.agentCommanderRows()?.terminalId !== terminalId) return undefined;
        this.launchClaim = undefined;
        const notices = this.options.database.commanderPendingNotices.list();
        if (notices.length === 0) return undefined;
        const delegations = notices.filter((notice) => notice.kind === 'delegation');
        const hasInterruptedTurn = notices.some((notice) => notice.kind === 'interrupted_turn');
        this.launchClaim = {
            claimedAt: this.now(),
            delegations,
            hasInterruptedTurn,
            oldestQueuedAt: notices[0].queuedAt,
            terminalId,
        };
        return formatCommanderResumePrompt(delegations, hasInterruptedTurn);
    }

    /**
     * Settles the launch prompt once its launch is running. A launch that started no Agent (a Shell-only relaunch)
     * carried no prompt, so its claim stays for the next Agent launch.
     */
    onLaunched(terminalId: string, didLaunchAgent: boolean): void {
        const claim = this.launchClaim;
        if (!didLaunchAgent || !claim || claim.terminalId !== terminalId) return;
        this.launchClaim = undefined;
        const store = this.options.database.commanderPendingNotices;
        store.removeDelegations(claim.delegations);
        if (claim.hasInterruptedTurn) store.clearTurn(claim.claimedAt);
        this.lastFinishedTurn = undefined;
        this.turnStartBaseline = undefined;
        this.options.logger?.write('info', logEventCatalog.agentCommander.resumePromptDelivered, {
            fields: {
                count: claim.delegations.length,
                interruptedTurn: claim.hasInterruptedTurn,
                waitMs: Math.max(0, this.now() - claim.oldestQueuedAt),
            },
        });
    }

    /**
     * A Chat Commander has no launch argv to carry a first prompt, so the same resume prompt goes in as its first Chat
     * message once the provider is ready. The Chat path of `write` ignores the launch ID. The claim settles only after
     * the Chat accepted the message, so a send that failed leaves the notices owed to the next launch.
     */
    onChatReady(terminalId: string): void {
        const prompt = this.launchPrompt(terminalId);
        if (prompt === undefined) return;
        this.options.write(terminalId, prompt, '', (wasAccepted) => {
            if (wasAccepted) this.onLaunched(terminalId, true);
        });
    }

    /**
     * A user stop is deliberate, so the turn it cut off must not be resumed on the next launch. Settled delegation
     * notices stay owed.
     */
    onStopped(): void {
        this.options.database.commanderPendingNotices.clearTurn();
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
        this.options.database.commanderPendingNotices.putDelegation({
            delegationId: receipt.delegationId,
            sessionId: receipt.sessionId,
            status,
            revision: receipt.revision,
            queuedAt: this.now(),
        });
        this.options.logger?.write('debug', logEventCatalog.agentCommander.completionNoticeQueued, {
            fields: {
                delegationId: receipt.delegationId,
                sessionId: receipt.sessionId,
                status,
                pendingCount: this.pendingDelegations().length,
            },
        });
        this.tryFlush(rows.terminalId);
    }
}

async function sendChatNotice(
    agentChat: Pick<AgentChatService, 'send'>,
    terminalId: string,
    text: string,
    onDelivered?: (wasAccepted: boolean) => void,
): Promise<void> {
    try {
        await agentChat.send(terminalId, { text });
    } catch {
        onDelivered?.(false);
        return;
    }
    onDelivered?.(true);
}

/**
 * Binds the notifier to the Server's coordinator, Terminal manager, and Chat service. A PTY write fixes `origin:
 * 'delegation'` so the injected notice line itself never bumps the input epoch a later notice's own draft fence reads.
 *
 * A Chat Commander takes the notice as a Chat message instead. The same idle fence still runs first: a Chat composer
 * draft lives in the Client and is never touched by a sent message, so the input epoch simply never moves for a Chat,
 * but the finished-turn proof keeps one notice per idle turn instead of a queued message behind every completion.
 */
export function createCommanderCompletionNotifier({
    agentChat,
    coordinator,
    database,
    logger,
    terminals,
}: {
    agentChat: Pick<AgentChatService, 'send'>;
    coordinator: Pick<AgentCoordinator, 'hasIdleProof'>;
    database: CommanderCompletionNotifierOptions['database'] & Pick<CaxriDatabase, 'getTerminal'>;
    logger?: StructuredLogger;
    terminals: Pick<TerminalManager, 'inputEpoch' | 'writeAgentExact'>;
}): CommanderCompletionNotifier {
    return new CommanderCompletionNotifier({
        database,
        hasIdleProof: (terminalId, launchId, turnId) =>
            coordinator.hasIdleProof(terminalId, launchId, turnId),
        inputEpoch: (terminalId) => terminals.inputEpoch(terminalId),
        logger,
        write: (terminalId, text, launchId, onDelivered) => {
            const terminal = database.getTerminal(terminalId);
            if (terminal && isChatTerminal(terminal)) {
                // eslint-disable-next-line no-void -- the outcome is reported through onDelivered
                void sendChatNotice(agentChat, terminalId, text, onDelivered);
                return true;
            }
            return terminals.writeAgentExact(
                terminalId,
                `${text}\r`,
                launchId,
                'delegation',
                onDelivered,
            );
        },
    });
}
