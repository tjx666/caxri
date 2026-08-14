import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { RendererReadiness } from '../renderer-readiness';

function contents(): EventEmitter {
    return new EventEmitter();
}

describe('Renderer readiness', () => {
    it('waits for the trusted preload acknowledgement before allowing one-shot work', async () => {
        const renderer = contents();
        const readiness = new RendererReadiness(1_000);
        readiness.track(renderer as never);
        let settled = false;
        const waiting = readiness.wait(renderer as never).finally(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(settled).toBe(false);
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
