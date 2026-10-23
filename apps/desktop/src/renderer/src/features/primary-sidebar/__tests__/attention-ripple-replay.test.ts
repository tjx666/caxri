import { afterEach, describe, expect, it, vi } from 'vitest';

import { replayAttentionRipplesOnFocus } from '../attention-ripple-replay';

function stubWindow(ripples: Array<{ getAnimations: () => Array<{ play: () => void }> }>) {
    const window = new EventTarget();
    vi.stubGlobal('addEventListener', window.addEventListener.bind(window));
    vi.stubGlobal('removeEventListener', window.removeEventListener.bind(window));
    const querySelectorAll = vi.fn(() => ripples);
    vi.stubGlobal('document', { querySelectorAll });
    return { querySelectorAll, window };
}

describe('replayAttentionRipplesOnFocus', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('plays every attention ripple again when the window gains focus', () => {
        const first = { play: vi.fn() };
        const second = { play: vi.fn() };
        const { querySelectorAll, window } = stubWindow([
            { getAnimations: () => [first] },
            { getAnimations: () => [second] },
        ]);
        const teardown = replayAttentionRipplesOnFocus();

        window.dispatchEvent(new Event('focus'));

        expect(querySelectorAll).toHaveBeenCalledWith('[data-session-status-ripple]');
        expect(first.play).toHaveBeenCalledTimes(1);
        expect(second.play).toHaveBeenCalledTimes(1);

        teardown();
        window.dispatchEvent(new Event('focus'));
        expect(first.play).toHaveBeenCalledTimes(1);
    });
});
