/** Orders output received during terminal attachment behind its restored snapshot. */
export class TerminalReplayBuffer {
    private restored = false;
    private readonly pending: string[] = [];

    constructor(private readonly write: (value: string) => void) {}

    push(value: string): void {
        if (this.restored) this.write(value);
        else this.pending.push(value);
    }

    restore(snapshot: string): void {
        if (this.restored) return;
        if (snapshot) this.write(snapshot);
        this.restored = true;
        for (const value of this.pending) this.write(value);
        this.pending.length = 0;
    }
}
