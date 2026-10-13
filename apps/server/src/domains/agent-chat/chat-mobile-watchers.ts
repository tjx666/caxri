/**
 * Counts the phones holding each Agent Chat open. Idle suspension treats a watched Chat as viewed, so a reply sent from
 * the phone never finds its provider stopped, matching how a phone-watched Conversation keeps a PTY Agent awake.
 */
export class ChatMobileWatchers {
    private readonly counts = new Map<string, number>();

    watch(terminalId: string): void {
        this.counts.set(terminalId, (this.counts.get(terminalId) ?? 0) + 1);
    }

    unwatch(terminalId: string): void {
        const count = this.counts.get(terminalId);
        if (count === undefined) return;
        if (count > 1) this.counts.set(terminalId, count - 1);
        else this.counts.delete(terminalId);
    }

    has(terminalId: string): boolean {
        return this.counts.has(terminalId);
    }
}
