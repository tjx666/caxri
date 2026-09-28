import { describe, expect, it, vi } from 'vitest';

import { TerminalProgressRegistry } from '../terminal-progress';

function createHarness() {
    const frames = new Map<number, () => void>();
    let nextFrame = 1;
    const requestFrame = vi.fn((callback: () => void) => {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
    });
    const cancelFrame = vi.fn((id: number) => frames.delete(id));
    const flushFrame = (): void => {
        const entry = frames.entries().next().value;
        if (!entry) throw new Error('Expected a pending animation frame');
        frames.delete(entry[0]);
        entry[1]();
    };
    return { cancelFrame, flushFrame, frames, requestFrame };
}

describe('TerminalProgressRegistry', () => {
    it('coalesces high-frequency updates into one frame and clamps percentages', () => {
        const harness = createHarness();
        const registry = new TerminalProgressRegistry(harness.requestFrame, harness.cancelFrame);
        const listener = vi.fn();
        registry.subscribe('terminal-a', listener);

        registry.update('terminal-a', { state: 1, value: 12 });
        registry.update('terminal-a', { state: 1, value: 37 });
        registry.update('terminal-a', { state: 1, value: 140 });

        expect(harness.requestFrame).toHaveBeenCalledTimes(1);
        expect(registry.get('terminal-a')).toBeUndefined();
        harness.flushFrame();
        expect(registry.get('terminal-a')).toEqual({ kind: 'normal', value: 100 });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies a later subscriber when an earlier one throws', () => {
        const harness = createHarness();
        const registry = new TerminalProgressRegistry(harness.requestFrame, harness.cancelFrame);
        const failing = vi.fn(() => {
            throw new Error('progress listener failure');
        });
        const surviving = vi.fn();
        registry.subscribe('terminal-a', failing);
        registry.subscribe('terminal-a', surviving);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        registry.update('terminal-a', { state: 1, value: 12 });
        harness.flushFrame();

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
    });

    it('keeps Terminal progress isolated and ignores malformed updates', () => {
        const harness = createHarness();
        const registry = new TerminalProgressRegistry(harness.requestFrame, harness.cancelFrame);

        registry.update('terminal-a', { state: 2, value: 30 });
        registry.update('terminal-b', { state: 4, value: 65 });
        harness.flushFrame();

        expect(registry.get('terminal-a')).toEqual({ kind: 'error', value: 30 });
        expect(registry.get('terminal-b')).toEqual({ kind: 'paused', value: 65 });

        registry.update('terminal-a', { state: 1, value: NaN });
        registry.update('terminal-a', { state: 8, value: 10 });
        expect(harness.frames.size).toBe(0);
        expect(registry.get('terminal-a')).toEqual({ kind: 'error', value: 30 });
    });

    it('cancels pending work and synchronously clears lifecycle state', () => {
        const harness = createHarness();
        const registry = new TerminalProgressRegistry(harness.requestFrame, harness.cancelFrame);
        const listener = vi.fn();
        registry.subscribe('terminal-a', listener);
        registry.update('terminal-a', { state: 3, value: 0 });
        harness.flushFrame();
        listener.mockClear();

        registry.update('terminal-a', { state: 1, value: 80 });
        registry.clear('terminal-a');

        expect(registry.get('terminal-a')).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(harness.cancelFrame).toHaveBeenCalledTimes(1);
        expect(harness.frames.size).toBe(0);
    });

    it('clears OSC 9;4 remove immediately and cancels a pending update', () => {
        const harness = createHarness();
        const registry = new TerminalProgressRegistry(harness.requestFrame, harness.cancelFrame);
        registry.update('terminal-a', { state: 1, value: 50 });
        harness.flushFrame();

        registry.update('terminal-a', { state: 0, value: 99 });
        expect(registry.get('terminal-a')).toBeUndefined();
        expect(harness.frames.size).toBe(0);

        registry.update('terminal-a', { state: 1, value: 75 });
        registry.update('terminal-a', { state: 0, value: 0 });
        expect(harness.frames.size).toBe(0);
        expect(registry.get('terminal-a')).toBeUndefined();
    });

    it('retains progress only for running Terminals in the selected Session', () => {
        const harness = createHarness();
        const registry = new TerminalProgressRegistry(harness.requestFrame, harness.cancelFrame);
        registry.update('terminal-a', { state: 1, value: 25 });
        registry.update('terminal-b', { state: 1, value: 75 });
        harness.flushFrame();
        registry.update('terminal-c', { state: 1, value: 90 });

        registry.retain(new Set(['terminal-b']));

        expect(registry.get('terminal-a')).toBeUndefined();
        expect(registry.get('terminal-b')).toEqual({ kind: 'normal', value: 75 });
        expect(harness.frames.size).toBe(0);
    });
});
