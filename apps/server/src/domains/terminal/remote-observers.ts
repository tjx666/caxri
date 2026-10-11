/**
 * Mobile observers currently watching each Terminal, recorded by a `TerminalExecutionPort` between a successful
 * `observe` and its `unobserve`. Automatic suspension reads it so a Terminal a phone is looking at counts as viewed.
 * Observer ids are a set per Terminal, so a repeated `observe` from one subscription (a generation change) is counted
 * once and a single `unobserve` releases it.
 */
export class TerminalRemoteObservers {
    private readonly observers = new Map<string, Set<string>>();

    add(terminalId: string, observerId: string): void {
        let ids = this.observers.get(terminalId);
        if (!ids) {
            ids = new Set();
            this.observers.set(terminalId, ids);
        }
        ids.add(observerId);
    }

    remove(terminalId: string, observerId: string): void {
        const ids = this.observers.get(terminalId);
        if (!ids) return;
        ids.delete(observerId);
        if (ids.size === 0) this.observers.delete(terminalId);
    }

    has(terminalId: string): boolean {
        return this.observers.has(terminalId);
    }
}
