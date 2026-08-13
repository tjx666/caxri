import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import {
    resolveTerminalRendererTarget,
    TerminalRendererController,
    type TerminalRendererStatus,
} from './terminal-renderer';

class FakeWebglAddon implements ITerminalAddon {
    readonly clearTextureAtlas = vi.fn();
    readonly dispose = vi.fn();
    private listener: (() => void) | undefined;

    activate(): void {}

    onContextLoss(listener: () => void) {
        this.listener = listener;
        return {
            dispose: () => {
                if (this.listener === listener) this.listener = undefined;
            },
        };
    }

    loseContext(): void {
        this.listener?.();
    }
}

function createHarness(options: { supported?: boolean; loadError?: Error } = {}) {
    const addon = new FakeWebglAddon();
    const statuses: TerminalRendererStatus[] = [];
    const host = {
        loadAddon: vi.fn((candidate: ITerminalAddon) => {
            if (options.loadError) throw options.loadError;
            candidate.activate({} as Terminal);
        }),
    };
    const redraw = vi.fn();
    const controller = new TerminalRendererController(
        host,
        redraw,
        (status) => statuses.push(status),
        () => options.supported ?? true,
        () => addon,
    );
    return { addon, controller, host, redraw, statuses };
}

describe('TerminalRendererController', () => {
    it('uses a deterministic Auto rule and keeps Off on DOM', () => {
        expect(resolveTerminalRendererTarget('off', true)).toBe('dom');
        expect(resolveTerminalRendererTarget('auto', false)).toBe('dom');
        expect(resolveTerminalRendererTarget('auto', true)).toBe('webgl');
        expect(resolveTerminalRendererTarget('on', false)).toBe('webgl');

        const harness = createHarness();
        harness.controller.setPreference('off');
        expect(harness.host.loadAddon).not.toHaveBeenCalled();
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'dom', reason: 'disabled' });
    });

    it('enables WebGL and hot-disables it with a full DOM redraw', () => {
        const harness = createHarness();
        harness.controller.setPreference('on');
        expect(harness.host.loadAddon).toHaveBeenCalledWith(harness.addon);
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'webgl', reason: 'active' });

        harness.controller.setPreference('off');
        expect(harness.addon.dispose).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'dom', reason: 'disabled' });
    });

    it('fails closed when WebGL activation is unavailable', () => {
        const harness = createHarness({ loadError: new Error('GPU unavailable') });
        harness.controller.setPreference('on');

        expect(harness.addon.dispose).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.statuses.at(-1)).toMatchObject({
            contextLossCount: 0,
            mode: 'dom',
            reason: 'load-failed',
        });
    });

    it('falls back on context loss without reloading the addon or touching another lifecycle', () => {
        const harness = createHarness();
        harness.controller.setPreference('on');
        harness.addon.loseContext();

        expect(harness.host.loadAddon).toHaveBeenCalledTimes(1);
        expect(harness.addon.dispose).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.statuses.at(-1)).toMatchObject({
            contextLossCount: 1,
            mode: 'dom',
            reason: 'context-loss',
        });
    });

    it('clears the texture atlas and redraws after the window becomes visible', () => {
        const harness = createHarness();
        harness.controller.setPreference('auto');
        harness.controller.restoreVisible();

        expect(harness.addon.clearTextureAtlas).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'webgl',
            reason: 'active',
            redrawCount: 1,
        });
    });
});
