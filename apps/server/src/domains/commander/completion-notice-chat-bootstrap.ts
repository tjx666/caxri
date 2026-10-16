interface ChatBootstrapLease {
    readonly terminalId: string;
    readonly launchId: string;
    ready: boolean;
    available: boolean;
    inFlight: boolean;
    started: boolean;
}

/**
 * One initial submission per ready Chat launch, independent of the PTY idle fence.
 */
export class CommanderChatBootstrap {
    private current: ChatBootstrapLease | undefined;

    private launch(terminalId: string, launchId: string): ChatBootstrapLease {
        if (this.current?.terminalId !== terminalId || this.current.launchId !== launchId)
            this.current = {
                terminalId,
                launchId,
                ready: false,
                available: true,
                inFlight: false,
                started: false,
            };
        return this.current;
    }

    ready(terminalId: string, launchId: string): void {
        this.launch(terminalId, launchId).ready = true;
    }

    started(terminalId: string, launchId: string): void {
        const lease = this.launch(terminalId, launchId);
        lease.started = true;
        lease.available = false;
    }

    isInFlight(terminalId: string): boolean {
        return this.current?.terminalId === terminalId && this.current.inFlight;
    }

    claim(terminalId: string): ChatBootstrapLease | undefined {
        const lease = this.current;
        if (!lease?.ready || lease.terminalId !== terminalId || !lease.available) return;
        lease.available = false;
        lease.inFlight = true;
        return lease;
    }

    settle(lease: ChatBootstrapLease, wasAccepted: boolean): boolean {
        if (this.current !== lease) return false;
        lease.inFlight = false;
        if (!wasAccepted && !lease.started) lease.available = true;
        return true;
    }

    reset(): void {
        this.current = undefined;
    }
}
