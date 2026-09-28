/**
 * Upper bound on permanently retired Terminal IDs the Host keeps fenced. Server Core cannot issue a lifecycle request
 * for a Terminal after `terminal.retire` (its launch path rechecks the durable record and the reserved identity before
 * sending), so this fence only has to outlive a short in-flight window, not the process lifetime. A burst larger than
 * this — such as deleting a Project with hundreds of Terminals — evicts the oldest IDs first.
 */
export const RETIRED_TERMINAL_FENCE_LIMIT = 256;

/**
 * Terminal Host's per-Terminal launch-generation authority. It retains the last started PTY generation only for IDs
 * Server Core can still rebuild — after natural exit, a failed launch (`discard`), or a restart barrier — so a later
 * `terminal.reserve` must name exactly the next generation. Permanent closure (`terminal.retire`) releases that entry
 * and records the ID in a bounded FIFO fence instead: an ID with no entry would otherwise fall back to the no-baseline
 * rule a replacement Host relies on and accept any generation, re-authorizing a late stale reserve or start.
 */
export class TerminalGenerationLedger {
    private readonly started = new Map<string, number>();
    private readonly retired = new Set<string>();

    /**
     * The only generation a new reservation may use, or undefined when this Host has no baseline for the ID (a fresh
     * Terminal, or any Terminal after a replacement Host started while Server Core kept counting).
     */
    launchGeneration(terminalId: string): number | undefined {
        const current = this.started.get(terminalId);
        return current === undefined ? undefined : current + 1;
    }

    isRetired(terminalId: string): boolean {
        return this.retired.has(terminalId);
    }

    recordStart(terminalId: string, generation: number): void {
        if (this.retired.has(terminalId)) return;
        this.started.set(terminalId, generation);
    }

    /**
     * Permanently forgets the ID's generation. Re-inserting refreshes its FIFO position so a repeated retire keeps the
     * most recent closure fenced longest.
     */
    retire(terminalId: string): void {
        this.started.delete(terminalId);
        this.retired.delete(terminalId);
        this.retired.add(terminalId);
        if (this.retired.size <= RETIRED_TERMINAL_FENCE_LIMIT) return;
        const [oldest] = this.retired;
        this.retired.delete(oldest);
    }
}
