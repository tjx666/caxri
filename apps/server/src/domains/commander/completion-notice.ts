import type { AgentDelegationReceipt } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal, SessionActivityTransition } from '../agents';
import { isLateMidTurnSignalAfterInterrupt, isMidTurnSignal, isStandaloneEscape } from '../agents';
import { agentCommanderTerminal } from '../db';
import type {
    CommanderCompletionNoticeDeferral,
    CommanderCompletionNoticeDeliveryFailure,
    CommanderCompletionNotifierOptions,
    CommanderLaunchPromptClaim,
} from './completion-notice-contract';
import { classifyCommanderCompletionNotice } from './completion-notice-contract';
import type { CommanderHandoverNoticeEntry, CommanderInboxNoticeEvent } from './notice-text';
import { formatCommanderCompletionNotice, formatCommanderResumePrompt } from './notice-text';
import { rememberNotifiedRevision } from './notified-revisions';
import { PromptlessCommanderLaunch } from './promptless-launch';
import { CommanderQueuedNotices } from './queued-notices';

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
    private readonly queued: CommanderQueuedNotices;
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
     * A launch that is idle at its first prompt and has never run a turn, so it has no finished turn to prove idle
     * against: a Commander started with nothing owed (no launch prompt), once its Chat reported ready or its Agent's
     * SessionStart arrived. Without it, a notice queued right after such a launch (the hand-over that just ran
     * `commander.ensure` to start it) waited until the user happened to talk to the Commander. The input epoch is
     * recorded so a keystroke since then means a draft, and one delivery or a started turn spends it.
     */
    private freshLaunch: { epoch: number; launchId: string } | undefined;
    private readonly promptlessLaunch = new PromptlessCommanderLaunch({
        now: () => this.now(),
        onTimeout: (terminalId, launchId) =>
            this.markFreshLaunch(terminalId, launchId, 'start_timeout'),
    });
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
    private launchClaim: CommanderLaunchPromptClaim | undefined;
    /**
     * The launch whose turn marker a standalone Escape just cleared, until a main-thread turn boundary or mid-turn
     * signal settles whether the Escape really interrupted that turn (see `settleEscapedTurn`).
     */
    private escapedTurnLaunchId: string | undefined;
    /**
     * When the last interrupt cleared the turn marker, so the interrupted turn's own late mid-turn hook does not mark
     * it again (see `isLateMidTurnSignalAfterInterrupt`).
     */
    private interruptedAt: number | undefined;

    constructor(private readonly options: CommanderCompletionNotifierOptions) {
        this.queued = new CommanderQueuedNotices({
            now: () => this.now(),
            onSessionsSettled: () => {
                const terminalId = this.commander()?.terminalId;
                if (terminalId) this.tryFlush(terminalId);
            },
            sessionTiming: options.sessionNoticeTiming,
        });
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

    /**
     * The live Commander Terminal, read in constant time. Runs for every human input chunk in every Terminal, so it
     * must not touch the created-Session list (`agentCommanderRows`), which costs one lookup per stored Session.
     */
    private pendingCount(): number {
        return this.pendingDelegations().length + this.queued.size;
    }

    private commander() {
        return agentCommanderTerminal(this.options.database);
    }

    /**
     * The launch a notice may be written to now, or why not yet: a finished turn proven idle with no draft typed since,
     * or else a fresh launch nobody typed into.
     */
    private idleLaunch(
        terminalId: string,
    ): { launchId: string } | { deferral: CommanderCompletionNoticeDeferral } {
        const finished = this.lastFinishedTurn;
        const fresh = this.freshLaunch;
        const epoch = this.options.inputEpoch(terminalId);
        if (
            !finished ||
            !this.options.hasIdleProof(terminalId, finished.launchId, finished.turnId)
        ) {
            if (!fresh) return { deferral: 'commander_busy' };
            return epoch === fresh.epoch ? fresh : { deferral: 'draft_input' };
        }
        const baseline = this.turnStartBaseline;
        if (!baseline || baseline.launchId !== finished.launchId)
            return { deferral: 'turn_baseline_missing' };
        if (epoch !== baseline.epoch && epoch !== this.submittedEpoch)
            return { deferral: 'draft_input' };
        return finished;
    }

    private deferral(terminalId: string): CommanderCompletionNoticeDeferral | { launchId: string } {
        const commander = this.commander();
        if (commander?.terminalId !== terminalId) return 'not_commander_terminal';
        const idle = this.idleLaunch(terminalId);
        if ('deferral' in idle) return idle.deferral;
        const session = this.options.database.getSession(commander.sessionId);
        /**
         * Only a pending permission/attention prompt blocks delivery. `hasUnread` is deliberately not a gate: every
         * settled Commander turn raises `completed` attention on its own Session, and nothing marks that Session read
         * because the Commander window is never a Workbench selection, so it would withhold every notice after the
         * Commander's first turn.
         */
        if (!session || session.lastActivityState === 'waiting') return 'awaiting_permission';
        return { launchId: idle.launchId };
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
        const queued = this.queued.deliverable(pending.length > 0);
        const { inbox, handovers, sessions } = queued;
        const pendingCount = pending.length + inbox.length + handovers.length + sessions.length;
        if (pendingCount === 0) return;
        const deferral = this.deferral(terminalId);
        if (typeof deferral === 'string') {
            if (isTurnFinished) this.blockedTurns += 1;
            if (deferral !== this.loggedDeferral) {
                this.loggedDeferral = deferral;
                this.options.logger?.write(
                    'debug',
                    logEventCatalog.agentCommander.completionNoticeDeferred,
                    {
                        fields: {
                            reason: deferral,
                            pendingCount,
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
        const { launchId } = deferral;
        /**
         * Consume before sending: even a write whose outcome is never confirmed must not be retried, so at-most-once
         * delivery holds regardless of what happens after this point. Mirrors `SessionCompaction.compact`'s own
         * consume-before-send comment for the identical reason.
         */
        this.options.database.commanderPendingNotices.removeDelegations(pending);
        this.queued.consume(queued);
        const waitMs = Math.max(
            0,
            this.now() - oldestQueuedAt([pending, inbox, handovers, sessions]),
        );
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
        this.freshLaunch = undefined;
        const text = formatCommanderCompletionNotice({ delegations: pending, ...queued });
        const accepted = this.options.write(terminalId, text, launchId, (wasAccepted) => {
            if (!wasAccepted) this.reportDeliveryFailed('unconfirmed');
        });
        if (!accepted) this.reportDeliveryFailed('rejected');
        else
            this.options.logger?.write(
                'info',
                logEventCatalog.agentCommander.completionNoticeDelivered,
                {
                    fields: {
                        count: pendingCount,
                        inboxCount: inbox.length,
                        handoverCount: handovers.length,
                        sessionCount: sessions.length,
                        waitMs,
                        blockedTurns,
                    },
                },
            );
    }

    /**
     * Keystrokes counted since the finished turn started, for a `draft_input` deferral: a count, never the input.
     */
    private inputsSinceTurnStart(terminalId: string): number {
        return this.options.inputEpoch(terminalId) - (this.turnStartBaseline?.epoch ?? 0);
    }

    /**
     * Marks a launch that started with no prompt idle at its first prompt, unless someone typed since it launched.
     */
    private markFreshLaunch(
        terminalId: string,
        launchId: string,
        reason: 'session_started' | 'start_timeout',
    ): void {
        const launch = this.promptlessLaunch.take();
        if (!launch || this.commander()?.terminalId !== terminalId) return;
        const epoch = this.options.inputEpoch(terminalId);
        if (epoch !== launch.epoch) return;
        this.freshLaunch = { epoch, launchId };
        this.options.logger?.write('info', logEventCatalog.agentCommander.freshLaunchReady, {
            fields: { reason, waitMs: Math.max(0, this.now() - launch.launchedAt) },
        });
        this.tryFlush(terminalId);
    }

    /**
     * A main-thread turn boundary supersedes an Escape's provisional interrupt; a mid-turn signal of the same launch
     * proves the TUI consumed the Escape for something else (closing a picker), so the turn is marked running again.
     */
    private settleEscapedTurn(signal: AgentLifecycleSignal): void {
        if (this.escapedTurnLaunchId === undefined || signal.agentId) return;
        const isMidTurn = signal.launchId === this.escapedTurnLaunchId && isMidTurnSignal(signal);
        // The interrupted turn's own late hook proves nothing; keep waiting for a boundary or a later signal.
        if (isMidTurn && isLateMidTurnSignalAfterInterrupt(signal, this.interruptedAt, this.now()))
            return;
        const isReopened = isMidTurn;
        if (!isReopened && !['turnFailed', 'turnFinished', 'turnStarted'].includes(signal.phase))
            return;
        this.escapedTurnLaunchId = undefined;
        if (isReopened) this.options.database.commanderPendingNotices.markTurnStarted(this.now());
    }

    private markInterrupted(): void {
        this.options.database.commanderPendingNotices.clearTurn();
        this.escapedTurnLaunchId = this.turnStartBaseline?.launchId;
        this.interruptedAt = this.now();
    }

    /**
     * An Agent Endpoint `SIGINT` interrupted this Terminal's Agent. It ends the turn exactly as a standalone Escape
     * does, so the persisted turn marker is cleared and a restart does not resume the abandoned work (GitHub issue
     * #1819).
     */
    observeInterrupt(terminalId: string): void {
        if (this.commander()?.terminalId !== terminalId) return;
        this.markInterrupted();
    }

    /**
     * Feeds every human input written to a Terminal, after its input epoch counted it. Only whether the input submitted
     * a line is kept; the text itself is never retained. A lone Enter outside a paste counts as a submission, so an
     * Enter that only accepted a completion popup and was the draft's last keystroke reads as submitted too: the TUI's
     * popup state is not visible here, and leaving the Commander silent after every steered message was the larger
     * harm.
     *
     * A standalone Escape is the user interrupting the turn, which Codex ends without a `Stop` hook, so its marker is
     * cleared and a restart does not resume the abandoned work (GitHub issue #1740). The keystroke is taken at face
     * value like the coordinator's own interrupt handling; `settleEscapedTurn` marks the turn again if it still runs.
     */
    observeInput(terminalId: string, data: string): void {
        if (this.commander()?.terminalId !== terminalId) return;
        if (isStandaloneEscape(data)) this.markInterrupted();
        if (data.includes('\u{1B}[200~')) this.isPasting = true;
        this.submittedEpoch =
            data === '\r' && !this.isPasting ? this.options.inputEpoch(terminalId) : undefined;
        if (data.includes('\u{1B}[201~')) this.isPasting = false;
    }

    /**
     * Feeds every lifecycle signal Server Core applies. Signals for a Terminal other than the current Commander
     * Terminal are ignored; a stopped or replaced Commander naturally stops matching once `agentCommanderTerminal` no
     * longer names that Terminal. A started turn is persisted until it finishes, fails, or is interrupted, which is how
     * the next launch knows a restart cut one off.
     */
    onLifecycleApplied(signal: AgentLifecycleSignal): void {
        if (this.commander()?.terminalId !== signal.terminalId) return;
        this.settleEscapedTurn(signal);
        /**
         * A subagent's turn is part of the Commander's own; only the main thread's turns mark or clear the marker.
         */
        const isMainThread = !signal.agentId;
        if (isMainThread && signal.phase === 'sessionIdentified') {
            this.markFreshLaunch(signal.terminalId, signal.launchId, 'session_started');
            return;
        }
        if (signal.phase === 'turnStarted') {
            this.promptlessLaunch.clear();
            this.freshLaunch = undefined;
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
        if (this.commander()?.terminalId !== terminalId) return undefined;
        this.launchClaim = undefined;
        const notices = this.options.database.commanderPendingNotices.list();
        // A launch is a natural batch boundary, so Session changes go out whether or not they settled.
        const queued = this.queued.deliverable(true);
        const groups = [notices, queued.inbox, queued.handovers, queued.sessions];
        if (groups.every((group) => group.length === 0)) return undefined;
        const delegations = notices.filter((notice) => notice.kind === 'delegation');
        const hasInterruptedTurn = notices.some((notice) => notice.kind === 'interrupted_turn');
        this.launchClaim = {
            claimedAt: this.now(),
            delegations,
            hasInterruptedTurn,
            queued,
            oldestQueuedAt: oldestQueuedAt(groups),
            terminalId,
        };
        return formatCommanderResumePrompt({ delegations, ...queued }, hasInterruptedTurn);
    }

    /**
     * Settles the launch prompt once its launch is running. A launch that started no Agent (a Shell-only relaunch, an
     * undefined `agentLaunchId`) carried no prompt, so its claim stays for the next Agent launch.
     */
    onLaunched(terminalId: string, agentLaunchId: string | undefined): void {
        const claim = this.launchClaim;
        if (agentLaunchId !== undefined && this.commander()?.terminalId === terminalId) {
            this.freshLaunch = undefined;
            this.promptlessLaunch.clear();
            if (claim?.terminalId !== terminalId)
                this.promptlessLaunch.arm(
                    terminalId,
                    agentLaunchId,
                    this.options.inputEpoch(terminalId),
                );
        }
        if (agentLaunchId === undefined || !claim || claim.terminalId !== terminalId) return;
        this.launchClaim = undefined;
        const store = this.options.database.commanderPendingNotices;
        store.removeDelegations(claim.delegations);
        if (claim.hasInterruptedTurn) store.clearTurn(claim.claimedAt);
        this.queued.consume(claim.queued);
        this.lastFinishedTurn = undefined;
        this.turnStartBaseline = undefined;
        this.options.logger?.write('info', logEventCatalog.agentCommander.resumePromptDelivered, {
            fields: {
                count: claim.delegations.length,
                inboxCount: claim.queued.inbox.length,
                handoverCount: claim.queued.handovers.length,
                sessionCount: claim.queued.sessions.length,
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
        if (prompt === undefined) {
            if (this.commander()?.terminalId !== terminalId) return;
            this.promptlessLaunch.clear();
            // The Chat path of `write` ignores the launch ID.
            this.freshLaunch = { epoch: this.options.inputEpoch(terminalId), launchId: '' };
            this.tryFlush(terminalId);
            return;
        }
        this.options.write(terminalId, prompt, '', (wasAccepted) => {
            // The Chat path of `write` ignores the launch ID.
            if (wasAccepted) this.onLaunched(terminalId, '');
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
        const terminalId = this.commander()?.terminalId;
        if (!terminalId || receipt.callerTerminalId !== terminalId) return;
        /**
         * Only a receipt the Commander Terminal itself dispatched pays for the created-Session list.
         */
        if (!this.options.database.agentCommanderRows()?.sessionIds.includes(receipt.sessionId))
            return;
        this.queued.observeDelegation(receipt.sessionId, receipt.status);
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
        rememberNotifiedRevision(this.notifiedRevisions, receipt.delegationId, receipt.revision);
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
                pendingCount: this.pendingCount(),
            },
        });
        this.tryFlush(terminalId);
    }

    /**
     * Queues one Inbox event for the Commander. Content-free like a delegation notice: the line names only the item ID
     * and a closed event word, and the Commander reads the reply itself with `commander inbox show`.
     */
    notifyInbox(itemId: string, event: CommanderInboxNoticeEvent): void {
        /**
         * Queued even while no Commander Terminal exists: the next launch prompt carries it (`launchPrompt`).
         */
        this.queued.putInbox({ itemId, event });
        this.options.logger?.write('debug', logEventCatalog.agentCommander.completionNoticeQueued, {
            fields: {
                itemId,
                inboxEvent: event,
                pendingCount: this.pendingCount(),
            },
        });
        const terminalId = this.commander()?.terminalId;
        if (terminalId) this.tryFlush(terminalId);
    }

    /**
     * Drops every queued Inbox event, for Clear Commander Data: the items they name no longer exist.
     */
    forgetInbox(): void {
        this.queued.forgetInbox();
    }

    /**
     * Queues one hand-over event for the Commander, content-free like the others: the hand-over and Session IDs and a
     * closed event word. The Commander reads the user's note from the task the hand-over recorded.
     */
    notifyHandover(entry: CommanderHandoverNoticeEntry): void {
        this.queued.putHandover(entry);
        this.options.logger?.write('debug', logEventCatalog.agentCommander.completionNoticeQueued, {
            fields: {
                handoverId: entry.handoverId,
                handoverEvent: entry.event,
                pendingCount: this.pendingCount(),
            },
        });
        const terminalId = this.commander()?.terminalId;
        if (terminalId) this.tryFlush(terminalId);
    }

    /**
     * Queues a managed Session's activity change, so the Commander hears about work the user did in a Session it
     * manages and an Agent there finishing, failing, or asking for input, not only about the tasks it dispatched. The
     * changes are batched (`CommanderQueuedNotices`). The Commander's own Session, a Session outside its managed set,
     * and a Session running a task it dispatched (the delegation notice covers it) are skipped.
     */
    notifySessionActivity({ sessionId, to }: SessionActivityTransition): void {
        const commander = this.commander();
        if (to === 'unknown' || !commander || commander.sessionId === sessionId) return;
        if (this.queued.isDelegated(sessionId)) return;
        // Only a change outside the Commander's own Session pays for the managed-Session list.
        if (!this.options.database.agentCommanderRows()?.sessionIds.includes(sessionId)) return;
        this.queued.putSession(sessionId, to);
        this.options.logger?.write('debug', logEventCatalog.agentCommander.completionNoticeQueued, {
            fields: { sessionId, sessionState: to, pendingCount: this.pendingCount() },
        });
    }
}

function oldestQueuedAt(groups: ReadonlyArray<ReadonlyArray<{ queuedAt: number }>>): number {
    return Math.min(...groups.flat().map((notice) => notice.queuedAt));
}
