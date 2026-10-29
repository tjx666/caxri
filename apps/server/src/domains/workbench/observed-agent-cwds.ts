const MAX_OBSERVED_AGENT_CWDS = 256;

/**
 * Last working directory each Terminal's Agent reported. Every hook event carries one, so this exists to make the
 * overwhelmingly common "unchanged" case a pure lookup instead of a Git read. Bounded, evicting the oldest entry.
 */
export class ObservedAgentCwds {
    private readonly byTerminal = new Map<string, string>();

    /**
     * Whether `reported` is still the newest directory seen for the Terminal, so a slower reconciliation of an older
     * report cannot overwrite a newer one.
     */
    isCurrent(terminalId: string, reported: string): boolean {
        return this.byTerminal.get(terminalId) === reported;
    }

    remember(terminalId: string, agentCwd: string): void {
        this.byTerminal.delete(terminalId);
        this.byTerminal.set(terminalId, agentCwd);
        while (this.byTerminal.size > MAX_OBSERVED_AGENT_CWDS) {
            const oldest = this.byTerminal.keys().next().value;
            if (!oldest) break;
            this.byTerminal.delete(oldest);
        }
    }

    forget(terminalId: string): void {
        this.byTerminal.delete(terminalId);
    }

    clear(): void {
        this.byTerminal.clear();
    }
}
