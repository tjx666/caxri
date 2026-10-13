import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { benchmarkWindowEventEffect } from '../benchmark-window-events';

/**
 * Events are built as the wire delivers them; the cast only spares each case the envelope fields this mapping never
 * reads.
 */
function event(name: ServerEvent['event'], payload: unknown): ServerEvent {
    return { event: name, payload } as ServerEvent;
}

const none = { snapshot: false, runs: false };

describe('benchmarkWindowEventEffect', () => {
    it('re-reads the snapshot on a full state change but ignores Session record changes', () => {
        expect(
            benchmarkWindowEventEffect(event('state.changed', { kind: 'full', reason: 'unknown' })),
        ).toEqual({ snapshot: true, runs: false });
        expect(
            benchmarkWindowEventEffect(
                event('state.changed', { kind: 'records', sessionIds: ['s'], terminalIds: [] }),
            ),
        ).toEqual(none);
    });

    it('re-reads the snapshot and every run once the Server is reachable again', () => {
        expect(benchmarkWindowEventEffect(event('runtime.status', { status: 'ready' }))).toEqual({
            snapshot: true,
            runs: true,
        });
        expect(benchmarkWindowEventEffect(event('runtime.status', { status: 'starting' }))).toEqual(
            none,
        );
        expect(
            benchmarkWindowEventEffect(event('host.connectionChanged', { status: 'connected' })),
        ).toEqual({ snapshot: true, runs: true });
        expect(
            benchmarkWindowEventEffect(event('host.connectionChanged', { status: 'replaced' })),
        ).toEqual(none);
    });

    it('follows configuration changes and leaves configuration errors to the Workbench window', () => {
        for (const name of ['settings.changed', 'keybindings.changed', 'theme.changed'] as const) {
            expect(benchmarkWindowEventEffect(event(name, {}))).toEqual({
                snapshot: true,
                runs: false,
            });
            expect(benchmarkWindowEventEffect(event(name, { error: 'invalid' }))).toEqual(none);
        }
    });

    it("tracks only its own window's full-screen state", () => {
        expect(
            benchmarkWindowEventEffect(
                event('window.fullScreen', { window: 'benchmark', isFullScreen: true }),
            ),
        ).toEqual({ ...none, isFullScreen: true });
        expect(
            benchmarkWindowEventEffect(
                event('window.fullScreen', { window: 'workbench', isFullScreen: true }),
            ),
        ).toEqual(none);
    });

    it('ignores events this window does not render', () => {
        expect(benchmarkWindowEventEffect(event('ui.command', { command: 'x' }))).toEqual(none);
    });
});
