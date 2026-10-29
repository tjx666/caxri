/**
 * While a session runs over the Relay, periodically checks whether a direct LAN or Tailscale path answers again, and
 * asks the owner to reconnect once it has answered steadily. The thresholds follow Orca's hysteresis so a phone on the
 * edge of Wi-Fi coverage does not flap between paths, each switch costing a fresh handshake and snapshot.
 */

export const DIRECT_PROBE_INTERVAL_MS = 30_000;
const DIRECT_PROBE_REQUIRED_SUCCESSES = 3;
/**
 * A Relay session younger than this never upgrades, so a reconnect that just fell back to the Relay is not undone.
 */
export const DIRECT_PROBE_MINIMUM_RELAY_AGE_MS = 60_000;

export interface DirectRouteProbeOptions {
    /**
     * Opens and immediately discards a direct socket; resolves whether any direct address accepted it. It never sends a
     * gateway hello.
     */
    probe: () => Promise<boolean>;
    /**
     * Called once the direct path answered steadily; the probe has stopped by then.
     */
    onUpgrade: () => void;
    /**
     * Whether switching now is safe, for example no mutation awaiting its reply. A refused upgrade keeps the streak and
     * retries on the next tick.
     */
    canUpgrade?: () => boolean;
    now?: () => number;
    readyAt: number;
    setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export class DirectRouteProbe {
    readonly #options: DirectRouteProbeOptions;
    #generation = 0;
    #handle?: ReturnType<typeof setInterval>;
    #isProbing = false;
    #streak = 0;

    constructor(options: DirectRouteProbeOptions) {
        this.#options = options;
    }

    async #tick(): Promise<void> {
        if (this.#isProbing) return;
        this.#isProbing = true;
        const generation = this.#generation;
        let isReachable: boolean;
        try {
            isReachable = await this.#options.probe();
        } catch {
            isReachable = false;
        }
        // A stop while the probe was in flight discards its answer.
        if (generation !== this.#generation) return;
        this.#isProbing = false;
        if (!isReachable) {
            this.#streak = 0;
            return;
        }
        this.#streak += 1;
        const now = (this.#options.now ?? Date.now)();
        if (
            this.#streak < DIRECT_PROBE_REQUIRED_SUCCESSES ||
            now - this.#options.readyAt < DIRECT_PROBE_MINIMUM_RELAY_AGE_MS ||
            !(this.#options.canUpgrade?.() ?? true)
        )
            return;
        this.stop();
        this.#options.onUpgrade();
    }

    get isRunning(): boolean {
        return this.#handle !== undefined;
    }

    /**
     * Starts probing; idempotent. A restart begins a new streak, since the network may have changed meanwhile.
     */
    start(): void {
        if (this.#handle !== undefined) return;
        this.#streak = 0;
        const schedule = this.#options.setInterval ?? setInterval;
        this.#handle = schedule(() => {
            void this.#tick();
        }, DIRECT_PROBE_INTERVAL_MS);
    }

    stop(): void {
        if (this.#handle === undefined) return;
        (this.#options.clearInterval ?? clearInterval)(this.#handle);
        this.#handle = undefined;
        this.#generation += 1;
        this.#isProbing = false;
        this.#streak = 0;
    }
}
