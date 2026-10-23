/**
 * Terminal launches between their request and the moment they land or fail. A restart registers before its barrier, so
 * a launch is visible here for its whole span, not only once its PTY start is in flight. A park that covers many
 * Terminals at once (`session.detach`, `terminal.terminateAll`) waits here, so a launch requested before the park
 * cannot land after it unseen.
 *
 * A request handler also does pre-launch work (working-directory identity, Agent Session lookup) before it calls
 * `start` or `restart`, and `terminal.create` has no Terminal record yet during that work. {@link begin} covers that
 * span per Session, so a detach that begins while a launch is still being prepared waits for it as well.
 */
export class InFlightLaunches {
    private readonly launches = new Map<string, Set<Promise<unknown>>>();
    private readonly preparations = new Map<string, Set<Promise<unknown>>>();

    private add(
        registry: Map<string, Set<Promise<unknown>>>,
        key: string,
        launch: Promise<unknown>,
    ) {
        const pending = registry.get(key) ?? new Set();
        pending.add(launch);
        registry.set(key, pending);
        void this.forgetWhenSettled(registry, key, launch);
    }

    private async forgetWhenSettled(
        registry: Map<string, Set<Promise<unknown>>>,
        key: string,
        launch: Promise<unknown>,
    ): Promise<void> {
        // The caller owns the launch's outcome; this only observes that it settled.
        await Promise.allSettled([launch]);
        const pending = registry.get(key);
        pending?.delete(launch);
        if (pending?.size === 0) registry.delete(key);
    }

    track<T>(terminalId: string, launch: Promise<T>): Promise<T> {
        this.add(this.launches, terminalId, launch);
        return launch;
    }

    /**
     * Opens a Session-scoped span for a launch that is still being prepared. The caller must release it in a `finally`
     * once it has called `start` or `restart` (which track the launch from then on) or given up; an unreleased span
     * would hold every park of the Session open.
     */
    begin(sessionId: string): () => void {
        const span = Promise.withResolvers<void>();
        this.add(this.preparations, sessionId, span.promise);
        return () => span.resolve();
    }

    /**
     * Resolves once no launch of a matching Terminal is in flight and no launch of the Session (every Session when
     * omitted) is being prepared, including launches requested while it waits.
     */
    async settled(isCovered: (terminalId: string) => boolean, sessionId?: string): Promise<void> {
        for (;;) {
            const pending = [
                ...this.launches
                    .entries()
                    .filter(([terminalId]) => isCovered(terminalId))
                    .flatMap(([, launches]) => launches),
                ...this.preparations
                    .entries()
                    .filter(([key]) => sessionId === undefined || key === sessionId)
                    .flatMap(([, preparations]) => preparations),
            ];
            if (pending.length === 0) return;
            // eslint-disable-next-line no-await-in-loop -- each pass re-reads launches requested meanwhile
            await Promise.allSettled(pending);
        }
    }
}
