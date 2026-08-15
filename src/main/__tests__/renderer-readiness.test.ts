import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { RendererReadiness } from '../renderer-readiness';

/**
 * Mocks Electron's WebContents, which is EventEmitter-based, and is consumed via
 * `.on()`/`.emit()` by the production `RendererReadiness` tracker.
 */
function contents(): EventEmitter {
    // eslint-disable-next-line unicorn/prefer-event-target -- see comment above
    return new EventEmitter();
}

describe('Renderer readiness', () => {
    it('waits for the trusted preload acknowledgement before allowing one-shot work', async () => {
        const renderer = contents();
        const readiness = new RendererReadiness(1_000);
        readiness.track(renderer as never);
        let isSettled = false;
        // `waiting` is intentionally observed here without awaiting so the assertion below can
        // check its not-yet-settled state; it is awaited later via `waiting` itself.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        const waiting = readiness.wait(renderer as never).finally(() => {
            isSettled = true;
        });

        await Promise.resolve();
        expect(isSettled).toBe(false);
        readiness.ready(renderer as never);
        await expect(waiting).resolves.toBeUndefined();
    });

    it('invalidates readiness when a main-frame reload starts', async () => {
        const renderer = contents();
        const readiness = new RendererReadiness(1_000);
        readiness.track(renderer as never);
        readiness.ready(renderer as never);
        await expect(readiness.wait(renderer as never)).resolves.toBeUndefined();

        renderer.emit('did-start-navigation', {}, 'file:///index.html', false, true);
        const waiting = readiness.wait(renderer as never);
        readiness.ready(renderer as never);
        await expect(waiting).resolves.toBeUndefined();
    });
});
