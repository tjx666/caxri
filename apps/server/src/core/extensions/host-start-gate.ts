/**
 * Closed reason recorded on `extension_host.ready`: Server Core startup (eager), a Desktop attaching, the first request
 * that needed the Host, or a supervised restart.
 */
export type ExtensionHostStartTrigger = 'core-start' | 'desktop-attached' | 'request' | 'restart';

/**
 * Tracks whether, and why, the Extension Host child was first asked to start. Until it was, `ExtensionService` drops
 * context-change notifications instead of forking the Host just to deliver them: a freshly started Host reads the
 * active context when an Extension activates, exactly as it does after a crash restart.
 */
export class ExtensionHostStartGate {
    #trigger?: ExtensionHostStartTrigger;
    #start?: Promise<void>;
    /**
     * A client connecting while Server Core tears down must not fork a Host that shutdown would immediately reap.
     */
    #isCoreStopping = false;

    get hasStarted(): boolean {
        return this.#trigger !== undefined;
    }

    /**
     * Runs `startHost` once, unless Server Core is already stopping.
     */
    start(
        trigger: Extract<ExtensionHostStartTrigger, 'core-start' | 'desktop-attached'>,
        startHost: () => Promise<void>,
    ): Promise<void> {
        if (this.#isCoreStopping) return Promise.resolve();
        this.#trigger ??= trigger;
        this.#start ??= startHost();
        return this.#start;
    }

    /**
     * A request that needs the Host starts it through the supervisor's own `request` path.
     */
    markRequested(): void {
        this.#trigger ??= 'request';
    }

    markCoreStopping(): void {
        this.#isCoreStopping = true;
    }

    /**
     * The reason to log for a Host that just became ready; every later start is a supervised restart.
     */
    takeReadyTrigger(): ExtensionHostStartTrigger {
        const trigger = this.#trigger ?? 'request';
        this.#trigger = 'restart';
        return trigger;
    }
}
