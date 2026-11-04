import type { AgentLifecycleSignal } from '../../agents';
import { isStandaloneEscape } from '../../agents';

interface TerminalProof {
    /**
     * The input epoch when the Agent's current turn started.
     */
    baseline?: { epoch: number; launchId: string };
    /**
     * The newest finished turn.
     */
    finished?: { launchId: string; turnId: string };
    /**
     * The input epoch right after the last human input was a submitted line; while it still equals the epoch, the
     * composer holds no draft.
     */
    submittedEpoch?: number;
    isPasting: boolean;
}

/**
 * What the proof reads from the rest of the Server.
 */
export interface PtyProofHost {
    inputEpoch?(terminalId: string): number | undefined;
    /**
     * `AgentCoordinator.hasIdleProof`: the exact launch's turn finished and the Terminal has been idle since.
     */
    isIdle?(terminalId: string, launchId: string, turnId: string): boolean;
}

/**
 * Why a PTY Agent cannot take a notice now: no finished turn is proven idle, or someone typed since the turn started
 * and did not submit it.
 */
export type PtyProofRefusal = 'no_idle_proof' | 'draft';

/**
 * Proves a PTY Agent is at an empty prompt, so a notice can be pasted and submitted without pressing Enter on the
 * user's half-typed line. It is the same fence Caxri Bot's completion notices use (`bot/completion-notice.ts`), kept
 * per Terminal: the finished turn's idle proof, plus an input epoch unchanged since that turn started unless the last
 * input submitted its line. Keystroke counts and turn IDs only; typed text is never kept.
 *
 * The residual risk is the one every exact-launch write accepts: a keystroke sent in the same event-loop turn as the
 * write, before its epoch bump is observed here, is not detectable.
 */
export class PtyIdleProof {
    private readonly terminals = new Map<string, TerminalProof>();

    constructor(private readonly host: PtyProofHost) {}

    private of(terminalId: string): TerminalProof {
        let proof = this.terminals.get(terminalId);
        if (!proof) {
            proof = { isPasting: false };
            this.terminals.set(terminalId, proof);
        }
        return proof;
    }

    /**
     * A lifecycle signal the coordinator applied. Only the main thread's turns count; a subagent's are part of them.
     */
    observeLifecycle(signal: AgentLifecycleSignal): void {
        if (signal.agentId) return;
        if (signal.phase === 'turnStarted') {
            const proof = this.of(signal.terminalId);
            proof.baseline = {
                epoch: this.host.inputEpoch?.(signal.terminalId) ?? 0,
                launchId: signal.launchId,
            };
            proof.finished = undefined;
        } else if (signal.phase === 'turnFinished' && signal.agentTurnId)
            this.of(signal.terminalId).finished = {
                launchId: signal.launchId,
                turnId: signal.agentTurnId,
            };
        else if (signal.phase === 'turnFailed') this.of(signal.terminalId).finished = undefined;
    }

    /**
     * Human input written to a Terminal, after its input epoch counted it. Only whether the input submitted a line is
     * kept: a lone Enter outside a bracketed paste. A standalone Escape interrupts the turn, so its finished-turn proof
     * is dropped.
     */
    observeInput(terminalId: string, data: string): void {
        const proof = this.terminals.get(terminalId);
        if (!proof) return;
        if (isStandaloneEscape(data)) proof.finished = undefined;
        if (data.includes('\u{1B}[200~')) proof.isPasting = true;
        proof.submittedEpoch =
            data === '\r' && !proof.isPasting ? this.host.inputEpoch?.(terminalId) : undefined;
        if (data.includes('\u{1B}[201~')) proof.isPasting = false;
    }

    /**
     * The launch the notice may be written to, or why not. `launchId` is the launch the caller must still be on.
     */
    check(terminalId: string, launchId: string): 'ok' | PtyProofRefusal {
        const proof = this.terminals.get(terminalId);
        const finished = proof?.finished;
        if (
            !proof ||
            !finished ||
            finished.launchId !== launchId ||
            this.host.isIdle?.(terminalId, finished.launchId, finished.turnId) !== true
        )
            return 'no_idle_proof';
        const { baseline } = proof;
        if (!baseline || baseline.launchId !== launchId) return 'no_idle_proof';
        const epoch = this.host.inputEpoch?.(terminalId) ?? 0;
        return epoch === baseline.epoch || epoch === proof.submittedEpoch ? 'ok' : 'draft';
    }

    /**
     * The newest finished turn of `launchId` when the Terminal has been idle since it, else `undefined`. The input
     * epoch is not consulted: a hand-back pins the epoch itself.
     */
    idleTurn(terminalId: string, launchId: string): string | undefined {
        const finished = this.terminals.get(terminalId)?.finished;
        return finished?.launchId === launchId &&
            this.host.isIdle?.(terminalId, launchId, finished.turnId) === true
            ? finished.turnId
            : undefined;
    }

    /**
     * Spends the finished-turn proof a write just used. The write never bumps the input epoch and does not invalidate
     * the idle proof, so without this a second flush a moment later would write into a Terminal that can no longer be
     * proven idle: every later write waits for its own fresh turn.
     */
    spend(terminalId: string): void {
        const proof = this.terminals.get(terminalId);
        if (proof) proof.finished = undefined;
    }

    forget(terminalId: string): void {
        this.terminals.delete(terminalId);
    }
}
