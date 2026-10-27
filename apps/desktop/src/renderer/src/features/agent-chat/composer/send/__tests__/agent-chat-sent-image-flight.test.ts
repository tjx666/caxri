import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendWithAgentChatImageFlight } from '../agent-chat-sent-image-flight';

const ON_SCREEN = { top: 10, left: 10, bottom: 100, right: 100, width: 90, height: 90 };
const OFF_SCREEN = { ...ON_SCREEN, top: -500, bottom: -400 };

interface FakeImage {
    src: string;
    style: Record<string, string>;
    isConnected: boolean;
    getBoundingClientRect: () => typeof ON_SCREEN;
    remove: () => void;
}

function image(rect: typeof ON_SCREEN, source = ''): FakeImage {
    const element: FakeImage = {
        src: source,
        style: {},
        isConnected: true,
        getBoundingClientRect: () => rect,
        remove: () => {
            element.isConnected = false;
        },
    };
    return element;
}

/**
 * The Renderer's tests run under Node, so the page is a fake `document`: the composer's thumbnails by attachment id,
 * the pending row's tiles that `send` puts on the page, and the clones appended to the body. Frames run only when the
 * test flushes them.
 */
function page(composer: Record<string, FakeImage>) {
    const state = {
        composer,
        pending: [] as FakeImage[],
        pendingId: '',
        clones: [] as FakeImage[],
    };
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
    vi.stubGlobal('document', {
        documentElement: {},
        body: { append: (clone: FakeImage) => state.clones.push(clone) },
        createElement: () => image(ON_SCREEN),
        querySelector: (selector: string) =>
            state.composer[/composer-image="(?<id>[^"]+)"/.exec(selector)?.groups?.id ?? ''] ??
            null,
        querySelectorAll: (selector: string) =>
            selector.includes(`"${state.pendingId}"`) ? state.pending : [],
    });
    const send = (pending: FakeImage[]) =>
        vi.fn(() => {
            state.composer = {};
            state.pending = pending;
            state.pendingId = 'pending-1';
            return 'pending-1';
        });
    const flushFrame = (): void => {
        const due = [...frames];
        frames.length = 0;
        for (const frame of due) frame();
    };
    return { flushFrame, send, state };
}

describe('sendWithAgentChatImageFlight', () => {
    let isReducesMotion = false;
    let finish: Array<() => void> = [];
    beforeEach(() => {
        isReducesMotion = false;
        finish = [];
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        vi.stubGlobal('matchMedia', () => ({ matches: isReducesMotion }));
        vi.stubGlobal('CSS', { escape: (value: string) => value });
        vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1200 });
        vi.stubGlobal('getComputedStyle', () => ({
            borderRadius: '8px',
            getPropertyValue: () => '',
        }));
        vi.stubGlobal(
            'KeyframeEffect',
            class {
                setKeyframes = vi.fn();
            },
        );
        vi.stubGlobal(
            'Animation',
            class {
                playState = 'running';
                finished = new Promise<void>((resolve) => finish.push(resolve));
                play = vi.fn();
                cancel = vi.fn();
            },
        );
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('flies each on-screen thumbnail to the tile at the same place and shows the tile once it lands', async () => {
        const { flushFrame, send, state } = page({
            a: image(ON_SCREEN, 'data:a'),
            b: image(OFF_SCREEN, 'data:b'),
        });
        const tiles = [image(ON_SCREEN), image(ON_SCREEN)];
        expect(sendWithAgentChatImageFlight(['a', 'b'], send(tiles))).toBe('pending-1');
        // Only the on-screen thumbnail flies, from where it was, and its tile waits hidden for it.
        expect(state.clones.map((clone) => [clone.src, clone.style.top])).toEqual([
            ['data:a', '10px'],
        ]);
        expect(tiles.map((tile) => tile.style.visibility)).toEqual(['hidden', undefined]);
        flushFrame();
        for (const resolve of finish) resolve();
        await vi.waitFor(() => expect(state.clones[0]?.isConnected).toBe(false));
        expect(tiles[0]?.style.visibility).toBe('');
    });

    it('drops a flight whose tile is off screen once measured', () => {
        const { flushFrame, send, state } = page({ a: image(ON_SCREEN, 'data:a') });
        const tile = image(OFF_SCREEN);
        sendWithAgentChatImageFlight(['a'], send([tile]));
        expect(tile.style.visibility).toBe('hidden');
        flushFrame();
        expect(state.clones[0]?.isConnected).toBe(false);
        expect(tile.style.visibility).toBe('');
    });

    it('releases the tiles when no frame ever runs, as in a hidden window', () => {
        const { send, state } = page({ a: image(ON_SCREEN, 'data:a') });
        const tile = image(ON_SCREEN);
        sendWithAgentChatImageFlight(['a'], send([tile]));
        vi.runAllTimers();
        expect(state.clones[0]?.isConnected).toBe(false);
        expect(tile.style.visibility).toBe('');
    });

    it('sends without a flight when nothing is attached or motion is reduced', () => {
        const { send, state } = page({ a: image(ON_SCREEN, 'data:a') });
        const tile = image(ON_SCREEN);
        expect(sendWithAgentChatImageFlight([], send([tile]))).toBe('pending-1');
        isReducesMotion = true;
        state.composer = { a: image(ON_SCREEN, 'data:a') };
        sendWithAgentChatImageFlight(['a'], send([tile]));
        expect(state.clones).toEqual([]);
        expect(tile.style.visibility).toBeUndefined();
    });
});
