import type { AgentChatTurn, TurnHoldReleaseReason } from '@caxri/protocol';

import type { AgentChatSessionHost } from '../../chat-provider';
import { ChatShellToolSignals } from '../../worktree/shell-tool-signals';
import type { ChatTurnHoldEvent } from '../chat-turn-hold';
import type { AcpToolCall, AcpToolPresentation } from './items';

type TurnStatus = AgentChatTurn['status'];

/**
 * The tool calls of an ACP Chat's turn that are still running: it feeds shell commands to the Workbench Root's worktree
 * attribution (see {@link ChatShellToolSignals}) and, for a dialect with `shouldHoldTurn`, holds the turn's end until
 * the calls that keep it open have finished.
 *
 * Antigravity's `agy acp` answers `session/prompt` with `end_turn` once it moves a slow foreground command to the
 * background, then reports the command finished later. Measured on agy 1.5.14: a 25 s `sleep` ended the prompt about 16
 * s after it started and finished 8 s after the prompt had ended, with no reply following it. Ending the turn on the
 * prompt's answer closed the still-running command as stopped and let the composer, attention, and a waiting delegation
 * read an unfinished turn as done. Paseo's Antigravity provider keeps such turns open the same way
 * (`deferTurnOnRunningTools`).
 */
export class AcpRunningTools {
    private readonly shellTools: ChatShellToolSignals;

    /**
     * Ids of the running calls that keep the turn open.
     */
    private readonly holding = new Set<string>();

    /**
     * Ends the turn whose prompt answered while calls in `holding` still ran.
     */
    private held: ((status?: TurnStatus) => void) | undefined;

    /**
     * Stop arrived before the prompt answered, so no turn was held yet. `agy` answers `end_turn` for a prompt it had
     * already ended when the cancel came, and holding that turn for its still-running command would leave it open until
     * the interrupt fallback stops the agent process.
     */
    private isStopPending = false;

    /**
     * When the current hold began, for the hold duration the release event reports.
     */
    private heldAt = 0;

    constructor(
        lifecycle: AgentChatSessionHost['lifecycle'],
        private readonly presentation: AcpToolPresentation,
        private readonly shouldHoldTurn?: (call: AcpToolCall) => boolean,
        /**
         * Receives a hold and its release as content-free events; injected so this class stays logger-free.
         */
        private readonly onHold?: (event: ChatTurnHoldEvent) => void,
    ) {
        this.shellTools = new ChatShellToolSignals(lifecycle);
    }

    private reportRelease(reason: TurnHoldReleaseReason): void {
        this.onHold?.({ kind: 'released', reason, holdMs: Date.now() - this.heldAt });
    }

    /**
     * Only a running (`in_progress`) call of the running turn can keep it open; `canHoldTurn` is false for a call the
     * user declined (Antigravity reports a declined command back as `in_progress` without ever finishing it) and for a
     * late update after the turn ended. A call waiting for approval cannot outlive its prompt.
     */
    observe(call: AcpToolCall, canHoldTurn: boolean): void {
        if (call.kind === 'execute') {
            if (call.status === 'completed') this.shellTools.ended(call.id, 'finished');
            else if (call.status === 'failed') this.shellTools.ended(call.id, 'failed');
            else this.shellTools.started(call.id, this.presentation.shellCommand(call));
        }
        const keepsOpen =
            canHoldTurn && call.status === 'in_progress' && this.shouldHoldTurn?.(call);
        if (keepsOpen) this.holding.add(call.id);
        else if (this.holding.delete(call.id) && this.holding.size === 0)
            this.release(undefined, 'call_finished');
    }

    /**
     * Ends the turn through `finish` now, or once the last call that keeps it open finishes. A prompt that answered
     * `interrupted` ends at once: Stop asked for that, and a cancelled command may never report its end.
     */
    endTurn(status: TurnStatus, finish: (status?: TurnStatus) => void): void {
        if (this.isStopPending) finish('interrupted');
        else if (status === 'interrupted' || this.holding.size === 0) finish();
        else {
            this.held = finish;
            this.heldAt = Date.now();
            this.onHold?.({ kind: 'held', holdingCalls: this.holding.size });
        }
    }

    /**
     * Ends a held turn now with `status`, as a Stop does. A Stop with no turn held yet ends the turn as interrupted
     * once its prompt answers.
     */
    release(status?: TurnStatus, reason?: TurnHoldReleaseReason): void {
        if (status === 'interrupted' && !this.held) this.isStopPending = true;
        const held = this.held;
        this.held = undefined;
        if (held) this.reportRelease(reason ?? 'stopped');
        held?.(status);
    }

    /**
     * Forgets every running call once the turn ended or the agent stopped. A turn still held at that point ended
     * without the calls finishing: `reason` says whether the process ended or another path closed the turn.
     */
    clear(reason: 'process_ended' | 'superseded' = 'process_ended'): void {
        this.shellTools.clear();
        this.holding.clear();
        if (this.held) this.reportRelease(reason);
        this.held = undefined;
        this.isStopPending = false;
    }
}
