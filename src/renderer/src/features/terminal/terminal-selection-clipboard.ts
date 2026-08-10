/** Serializes clipboard writes so a slow, older xterm selection cannot replace the latest one. */
export class TerminalSelectionClipboard {
    private pending: string | undefined;
    private running: Promise<void> | undefined;

    constructor(
        private readonly writeText: (value: string) => Promise<void>,
        private readonly onFailure: (error: unknown) => void,
    ) {}

    copy(selection: string): Promise<void> {
        if (selection) this.pending = selection;
        if (!this.running && this.pending !== undefined) {
            this.running = this.drain().finally(() => {
                this.running = undefined;
            });
        }
        return this.running ?? Promise.resolve();
    }

    private async drain(): Promise<void> {
        const selection = this.pending;
        if (selection === undefined) return;
        this.pending = undefined;
        try {
            await this.writeText(selection);
        } catch (error) {
            this.onFailure(error);
        }
        await this.drain();
    }
}
