/** Orders output received during terminal attachment behind its restored snapshot. */
export class TerminalReplayBuffer {
    private restored = false;
    private restoration?: Promise<void>;
    private readonly pending: string[] = [];

    constructor(private readonly write: (value: string) => Promise<void>) {}

    push(value: string): void {
        if (this.restored) void this.write(value);
        else this.pending.push(value);
    }

    restore(snapshot: string): Promise<void> {
        this.restoration ??= this.restoreOnce(snapshot);
        return this.restoration;
    }

    private async restoreOnce(snapshot: string): Promise<void> {
        if (snapshot) await this.write(snapshot);
        while (this.pending.length > 0) await this.write(this.pending.shift()!);
        this.restored = true;
    }
}
