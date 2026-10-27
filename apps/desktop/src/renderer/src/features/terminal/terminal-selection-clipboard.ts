import { writeClipboardText } from '../../lib/clipboard';

/**
 * Serializes clipboard writes so a slow, older xterm selection cannot replace the latest one.
 */
export class TerminalSelectionClipboard {
    private pending: string | undefined;
    private running: Promise<void> | undefined;

    constructor(
        private readonly onFailure: (error: unknown) => void,
        private readonly writeText: (value: string) => Promise<void> = writeClipboardText,
    ) {}

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

    private async runDrain(): Promise<void> {
        try {
            await this.drain();
        } finally {
            this.running = undefined;
        }
    }

    copy(selection: string): Promise<void> {
        if (selection) this.pending = selection;
        if (!this.running && this.pending !== undefined) this.running = this.runDrain();
        return this.running ?? Promise.resolve();
    }
}
