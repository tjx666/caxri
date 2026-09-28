import type { AgentDelegationReceipt } from '@caxri/protocol';
import { normalizeTerminalTitle } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal } from '../agents';
import type { CaxriDatabase } from '../db';

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
 * the finished turn's idle proof, and an input epoch unchanged since that turn started. A draft typed mid-turn or after
 * it, or a pending attention/permission request, defers delivery to the next clean idle point instead of guessing
 * whether Enter is safe to send. The residual risk is the same in-flight-keystroke race every exact-launch write
 * already accepts: a keystroke sent in the same event-loop turn as the write, before its epoch bump is observed here,
 * is not detectable.
 *
 * Pending notices live only in memory: a delegation transition consumed by a batch (see `tryFlush`) can never be sent
 * twice, but an undelivered batch does not survive a Codex relaunch or a Server restart. `commander board` and the
 * ledger the Commander keeps in its workspace are the compensation for that loss, exactly as they already are for the
 * pre-existing `agent delegate wait` / board-polling path this feature supplements.
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

    constructor(private readonly options: CommanderCompletionNotifierOptions) {}

    private reportDeliveryFailed(reason: CommanderCompletionNoticeDeliveryFailure): void {
        this.options.logger?.write(
            'warn',
            logEventCatalog.agentCommander.completionNoticeDeliveryFailed,
            { fields: { reason } },
        );
    }

    /**
     * Attempts to deliver every currently pending notice as one coalesced line. Returns without effect, and without
     * logging, whenever a gate simply is not satisfied yet: that is the ordinary, frequent path while the Commander is
     * mid-turn, and it resolves itself the next time a turn settles or a new notice arrives.
     */
    private tryFlush(terminalId: string): void {
        if (this.pending.size === 0) return;
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId || rows.terminalId !== terminalId) return;
        const finished = this.lastFinishedTurn;
        if (!finished || !this.options.hasIdleProof(terminalId, finished.launchId, finished.turnId))
            return;
        const baseline = this.turnStartBaseline;
        if (!baseline || baseline.launchId !== finished.launchId) return;
        if (this.options.inputEpoch(terminalId) !== baseline.epoch) return;
        const session = this.options.database.getSession(rows.sessionId);
        /**
         * Only a pending permission/attention prompt blocks delivery. `hasUnread` is deliberately not a gate: every
         * settled Commander turn raises `completed` attention on its own Session, and nothing marks that Session read
         * because the Commander window is never a Workbench selection, so it would withhold every notice after the
         * Commander's first turn.
         */
        if (!session || session.lastActivityState === 'waiting') return;
        const entries = this.pending.values().toArray();
        /**
         * Consume before sending: even a write whose outcome is never confirmed must not be retried, so at-most-once
         * delivery holds regardless of what happens after this point. Mirrors `SessionCompaction.compact`'s own
         * consume-before-send comment for the identical reason.
         */
        this.pending.clear();
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
                { fields: { count: entries.length } },
            );
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
        this.tryFlush(signal.terminalId);
    }

    /**
     * Feeds every delegation receipt change. Only a transition the Commander itself dispatched
     * (`receipt.callerTerminalId` is the Commander Terminal) into a Session it created is eligible; an external
     * delegation caller that happens to target a Commander Session is not this module's concern.
     */
    notifyReceiptChanged(receipt: AgentDelegationReceipt): void {
        const rows = this.options.database.agentCommanderRows();
        if (!rows?.terminalId) return;
        if (receipt.callerTerminalId !== rows.terminalId) return;
        if (!rows.sessionIds.includes(receipt.sessionId)) return;
        const status = classifyCommanderCompletionNotice(receipt);
        if (!status) return;
        const notifiedRevision = this.notifiedRevisions.get(receipt.delegationId) ?? 0;
        if (receipt.revision <= notifiedRevision) return;
        this.notifiedRevisions.set(receipt.delegationId, receipt.revision);
        this.pending.set(receipt.delegationId, {
            delegationId: receipt.delegationId,
            sessionId: receipt.sessionId,
            status,
        });
        this.tryFlush(rows.terminalId);
    }
}
