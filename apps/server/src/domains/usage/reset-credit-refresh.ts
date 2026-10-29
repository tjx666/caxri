import type { AgentProvider, UsageResetCredits } from '@caxri/protocol';

/**
 * Providers that hold banked rate-limit resets. Only Codex does (its reset credits); neither its transcript nor a PTY
 * records them, so a running Codex Chat is asked.
 */
const RESET_CREDIT_PROVIDERS: ReadonlySet<AgentProvider> = new Set(['codex']);

/**
 * How long a successful reading is reused. Credits are granted and expire on a scale of days, and the read asks Codex's
 * backend, so the status bar's 2-second poll must not turn into a request each time.
 */
const FRESH_MS = 5 * 60_000;

/**
 * How long to wait after a failed read before asking again.
 */
const RETRY_MS = 60_000;

/**
 * Keeps the status bar's banked-reset count for a provider current while one of its Chats is in view. Each live usage
 * read may ask the Chat, never twice at once and never waiting: the answer reaches the next poll through `observe`. A
 * Terminal with no running Chat (a PTY Agent, a stopped Chat) answers nothing and is asked again on the next poll, so
 * switching to a Chat shows its credits within one poll.
 */
export class ResetCreditRefresh {
    private readonly nextAskAt = new Map<AgentProvider, number>();
    private readonly pending = new Set<AgentProvider>();

    constructor(
        private readonly read:
            | ((terminalId: string) => Promise<{ resetCredits?: UsageResetCredits } | undefined>)
            | undefined,
        private readonly observer: {
            observeResetCredits(
                provider: AgentProvider,
                credits: UsageResetCredits | undefined,
            ): void;
        },
        private readonly now: () => number,
    ) {}

    private async ask(
        read: NonNullable<ResetCreditRefresh['read']>,
        provider: AgentProvider,
        terminalId: string,
    ): Promise<void> {
        try {
            const answer = await read(terminalId);
            if (!answer) return;
            this.observer.observeResetCredits(provider, answer.resetCredits);
            this.nextAskAt.set(provider, this.now() + FRESH_MS);
        } catch {
            // A Chat that closed mid-request or a Codex that cannot answer: keep the last reading, retry later.
            this.nextAskAt.set(provider, this.now() + RETRY_MS);
        } finally {
            this.pending.delete(provider);
        }
    }

    request(provider: AgentProvider, terminalId: string): void {
        if (!this.read || !RESET_CREDIT_PROVIDERS.has(provider) || this.pending.has(provider))
            return;
        if (this.now() < (this.nextAskAt.get(provider) ?? 0)) return;
        this.pending.add(provider);
        void this.ask(this.read, provider, terminalId);
    }
}
