import { CaxriError } from '@caxri/protocol';
import type { WebContents } from 'electron';

type ReadinessOutcome = 'closed' | 'ready' | 'superseded';

interface ReadinessEntry {
    promise: Promise<ReadinessOutcome>;
    settle(outcome: ReadinessOutcome): void;
}

/**
 * Tracks each main-frame generation until its preload has attached the one-shot event listener.
 *
 * The timeout bounds a single `wait()` call, never the generation itself: a handshake that arrives after a waiter gave
 * up (a cold Vite dependency prebundle, a slow first launch) still marks the generation ready, so later waits succeed
 * instead of failing until the next navigation.
 */
export class RendererReadiness {
    private readonly entries = new WeakMap<WebContents, ReadinessEntry>();

    constructor(private readonly timeoutMs = 15_000) {}

    track(contents: WebContents): void {
        const begin = (): void => {
            this.entries.get(contents)?.settle('superseded');
            let isSettled = false;
            const { promise, resolve } = Promise.withResolvers<ReadinessOutcome>();
            const settle = (outcome: ReadinessOutcome): void => {
                if (isSettled) return;
                isSettled = true;
                resolve(outcome);
            };
            this.entries.set(contents, { promise, settle });
        };
        begin();
        contents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
            if (isMainFrame) begin();
        });
        contents.once('destroyed', () => this.entries.get(contents)?.settle('closed'));
    }

    ready(contents: WebContents): void {
        this.entries.get(contents)?.settle('ready');
    }

    /**
     * Waits up to the timeout for the current generation; a user action fails fast instead of hanging.
     */
    async wait(contents: WebContents): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
            timer.unref();
        });
        try {
            const entry = this.entries.get(contents);
            const outcome = entry ? await Promise.race([entry.promise, timeout]) : undefined;
            if (outcome !== 'ready')
                throw new CaxriError(
                    'UNAVAILABLE',
                    outcome === 'timeout'
                        ? 'Desktop Renderer did not become ready'
                        : 'Desktop window changed before it became ready',
                );
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Waits without a time limit until some main-frame generation becomes ready, following reloads that supersede a
     * pending one. Startup work that must eventually run once (auxiliary window restore, second-instance focus) uses
     * this so a slow first handshake delays it rather than skipping it for the whole app lifetime.
     */
    async whenReady(contents: WebContents): Promise<void> {
        const outcome = await this.entries.get(contents)?.promise;
        if (outcome === 'ready') return;
        if (outcome === 'superseded') return this.whenReady(contents);
        throw new CaxriError('UNAVAILABLE', 'Desktop window closed before it became ready');
    }
}
