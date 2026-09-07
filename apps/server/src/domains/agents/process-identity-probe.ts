import type { TerminalRecord } from '@caxri/protocol';

/**
 * Keeps content-free process identity attempts bounded to one live, unbound Codex Terminal generation.
 */
export class ProcessIdentityProbe {
    private readonly terminals = new Map<string, { pid: number; lastAttemptAt?: number }>();

    observe(terminalId: string, pid?: number): void {
        if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
        if (this.terminals.get(terminalId)?.pid !== pid) this.terminals.set(terminalId, { pid });
    }

    take(terminal: TerminalRecord): number | undefined {
        if (
            terminal.provider !== 'codex' ||
            terminal.agentSessionId ||
            terminal.lastProcessState !== 'running'
        )
            return undefined;
        const state = this.terminals.get(terminal.id);
        if (!state) return undefined;
        const now = Date.now();
        if (state.lastAttemptAt !== undefined && now - state.lastAttemptAt < 30_000)
            return undefined;
        state.lastAttemptAt = now;
        return state.pid;
    }

    forget(terminalId: string): void {
        this.terminals.delete(terminalId);
    }

    clear(): void {
        this.terminals.clear();
    }
}
