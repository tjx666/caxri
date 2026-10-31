import { commandCreatesWorktree, isOpaqueAgentSessionId } from '../../agents';
import { stringField } from '../chat-items';
import type { AgentChatSessionHost } from '../chat-provider';

/**
 * Bounds the commands awaiting their outcome; a provider that never reports one cannot grow the map without limit.
 */
const MAX_TRACKED_COMMANDS = 256;

const MAX_TOOL_USE_ID_LENGTH = 256;

/**
 * Synthesizes the `shellTool*` lifecycle signals for a Chat whose provider reports shell commands only as protocol
 * notifications: Codex app-server's `commandExecution` items and an ACP agent's `execute` tool calls (issue
 * caxri#1849). Claude Chat blocks Bash in-process instead (`providers/claude/shell-hooks.ts`).
 *
 * Neither protocol can hold a command back, so the before-snapshot of a `git worktree add` is captured when the command
 * is first seen. Both providers report the command before they ask for its approval, so with approvals on the snapshot
 * lands while the command waits; under Full access it races the command. A snapshot that already holds the new worktree
 * proves no addition and follows nothing, so the race mostly costs a missed follow. The outcome is sent as soon as it
 * is reported, so the signals keep their order relative to the turn's end; the Workbench Root's attribution pairs an
 * outcome that overtakes its start's snapshot once that snapshot lands.
 *
 * Only the classification and the opaque command id leave the provider; the command and its output do not.
 */
export class ChatShellToolSignals {
    /**
     * Whether each started command, by its provider id, may create a worktree.
     */
    private readonly commands = new Map<string, boolean>();

    constructor(private readonly lifecycle: AgentChatSessionHost['lifecycle']) {}

    private emit(
        phase: 'shellToolFailed' | 'shellToolFinished' | 'shellToolStarted',
        id: string,
        isWorktreeCreation: boolean,
    ): void {
        this.lifecycle({
            phase,
            ...(isWorktreeCreation && { agentToolUseId: id, worktreeCreateIntent: true }),
        });
    }

    /**
     * A command began, or was first reported. Later reports of the same command are ignored, since a repeated start of
     * one creation reads as ambiguous.
     */
    started(id: string, command: string | undefined): void {
        if (this.commands.has(id)) return;
        if (this.commands.size >= MAX_TRACKED_COMMANDS) {
            const oldest = this.commands.keys().next().value;
            if (oldest !== undefined) this.commands.delete(oldest);
        }
        // Like the bridge, a command that cannot create a worktree carries no pairing identity; its outcome still
        // drives the deletion revalidation of a followed worktree.
        const isWorktreeCreation =
            commandCreatesWorktree(command) &&
            id.length <= MAX_TOOL_USE_ID_LENGTH &&
            isOpaqueAgentSessionId(id);
        this.commands.set(id, isWorktreeCreation);
        this.emit('shellToolStarted', id, isWorktreeCreation);
    }

    /**
     * A command ended. Only a command started in the running turn reports its outcome: one that outlived its turn (a
     * Codex background terminal) would read as a running turn to every consumer of mid-turn signals.
     */
    ended(id: string, outcome: 'failed' | 'finished'): void {
        const createsWorktree = this.commands.get(id);
        if (createsWorktree === undefined) return;
        this.commands.delete(id);
        this.emit(
            outcome === 'finished' ? 'shellToolFinished' : 'shellToolFailed',
            id,
            createsWorktree,
        );
    }

    /**
     * The turn or the provider process ended; a command still running reports no outcome.
     */
    clear(): void {
        this.commands.clear();
    }
}

/**
 * Feeds a Codex `commandExecution` item to the Workbench Root's worktree attribution; see {@link ChatShellToolSignals}.
 */
export function observeCodexCommand(
    signals: ChatShellToolSignals,
    raw: Record<string, unknown>,
    isStarted: boolean,
): void {
    const id = stringField(raw.id);
    if (!id) return;
    if (isStarted) {
        signals.started(id, stringField(raw.command));
        return;
    }
    // A command that exited non-zero created nothing worth following, even when Codex reports it `completed`.
    const isSuccess = raw.status === 'completed' && (raw.exitCode ?? 0) === 0;
    if (isSuccess) signals.ended(id, 'finished');
    else if (raw.status !== 'inProgress') signals.ended(id, 'failed');
}
