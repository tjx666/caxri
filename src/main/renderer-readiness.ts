import type { WebContents } from 'electron';

import { CaxriError } from '../shared/ipc/errors';

type ReadinessOutcome = 'closed' | 'ready' | 'superseded' | 'timeout';

interface ReadinessEntry {
    promise: Promise<ReadinessOutcome>;
    settle(outcome: ReadinessOutcome): void;
}

/**
Tracks each main-frame generation until its preload has attached the one-shot event listener.
 */
export class RendererReadiness {
    private readonly entries = new WeakMap<WebContents, ReadinessEntry>();

    constructor(private readonly timeoutMs = 15_000) {}

    track(contents: WebContents): void {
        const begin = (): void => {
            this.entries.get(contents)?.settle('superseded');
            let isSettled = false;
            const { promise, resolve } = Promise.withResolvers<ReadinessOutcome>();
            /**
             * `settle` no longer needs to clear the timer directly: the `isSettled` guard already
             * makes a late `timeout` firing a harmless no-op, so the timer/settle pair no longer
             * needs a mutual forward reference.
             */
            const settle = (outcome: ReadinessOutcome): void => {
                if (isSettled) return;
                isSettled = true;
                resolve(outcome);
            };
            const timer = setTimeout(() => settle('timeout'), this.timeoutMs);
            timer.unref();
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

    async wait(contents: WebContents): Promise<void> {
        const outcome = await this.entries.get(contents)?.promise;
        if (outcome !== 'ready')
            throw new CaxriError(
                'UNAVAILABLE',
                outcome === 'timeout'
                    ? 'Desktop Renderer did not become ready'
                    : 'Desktop window changed before it became ready',
            );
    }
}
