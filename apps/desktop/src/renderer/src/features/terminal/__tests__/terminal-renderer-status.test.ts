import { describe, expect, it, vi } from 'vitest';

import type { TerminalRendererStatus } from '../terminal-renderer';
import {
    terminalRendererIndicator,
    TerminalRendererStatusRegistry,
} from '../terminal-renderer-status';

function status(overrides: Partial<TerminalRendererStatus>): TerminalRendererStatus {
    return {
        contextLossCount: 0,
        liveWebglContextCount: 1,
        mode: 'webgl',
        reason: 'active',
        recoveryResult: 'not-requested',
        redrawCount: 0,
        retryAttemptCount: 0,
        retryDelayMs: null,
        retryLimit: 3,
        retryState: 'idle',
        trigger: 'preference-change',
        ...overrides,
    };
}

describe('terminalRendererIndicator', () => {
    it('stays silent for the healthy WebGL renderer and disposed panes', () => {
        expect(terminalRendererIndicator(undefined)).toBeUndefined();
        expect(terminalRendererIndicator(status({}))).toBeUndefined();
        expect(
            terminalRendererIndicator(status({ mode: 'dom', reason: 'disposed' })),
        ).toBeUndefined();
    });

    it('explains why the Terminal fell back to software rendering', () => {
        expect(terminalRendererIndicator(status({ mode: 'dom', reason: 'disabled' }))).toEqual({
            action: {
                confirmLabel: 'Turn On',
                message:
                    'Terminals start drawing with the GPU immediately, without restarting Caxri or the Terminal. You can turn it off again in Settings.',
                preference: 'on',
                title: 'Turn on Terminal hardware acceleration?',
            },
            ariaLabel:
                'Turn on Terminal hardware acceleration? — Terminal is using software rendering. Terminal hardware acceleration is turned off in Settings.',
            label: 'Software',
            title: 'Turn on Terminal hardware acceleration? — Terminal is using software rendering. Terminal hardware acceleration is turned off in Settings.',
        });
        expect(
            terminalRendererIndicator(
                status({
                    contextLossCount: 1,
                    liveWebglContextCount: 1,
                    mode: 'dom',
                    reason: 'context-loss',
                    retryAttemptCount: 1,
                    retryState: 'scheduled',
                }),
            )?.title,
        ).toBe(
            'Terminal is using software rendering. GPU drawing was interrupted. Trying the GPU again (1/3).',
        );
        expect(
            terminalRendererIndicator(
                status({
                    mode: 'dom',
                    reason: 'load-failed',
                    retryAttemptCount: 3,
                    retryState: 'exhausted',
                }),
            )?.title,
        ).toContain('Retries exhausted');
    });

    it('explains a session pinned to software rendering after repeated GPU incidents', () => {
        expect(
            terminalRendererIndicator(status({ mode: 'dom', reason: 'context-loss-limit' }))?.title,
        ).toBe(
            'Retry GPU rendering? — Terminal is using software rendering. Drawing failed repeatedly. Automatic recovery is paused; click to retry GPU rendering.',
        );
        // A pane whose own retries ran out before the session pinned must not keep promising that a reopened tab
        // retries WebGL; the pin's closed reason wins over the exhausted retry state.
        const pinnedAfterExhaustion = terminalRendererIndicator(
            status({
                mode: 'dom',
                reason: 'context-loss-limit',
                retryAttemptCount: 3,
                retryState: 'exhausted',
            }),
        );
        expect(pinnedAfterExhaustion?.title).not.toContain('reopen the Terminal tab');
        expect(pinnedAfterExhaustion?.title).toContain('click to retry');
    });

    it('offers enabling for disabled GPU and a direct retry for settled failures', () => {
        expect(
            terminalRendererIndicator(status({ mode: 'dom', reason: 'disabled' }))?.action,
        ).toEqual(expect.objectContaining({ preference: 'on' }));
        for (const reason of [
            'unsupported',
            'context-loss',
            'context-loss-limit',
            'load-failed',
        ] as const) {
            const indicator = terminalRendererIndicator(status({ mode: 'dom', reason }));
            expect(indicator?.action).toEqual(
                expect.objectContaining({
                    confirmLabel: 'Retry GPU',
                    title: 'Retry GPU rendering?',
                }),
            );
            expect(indicator?.action && 'preference' in indicator.action).toBe(false);
            expect(indicator?.ariaLabel).toContain('Retry GPU rendering?');
        }
    });

    /**
     * `unsupported` is published by a live `getContext('webgl2')` probe, which a pane mounted during a GPU process
     * restart fails and a later re-probe passes. The chip must therefore keep offering the retry that recovers it, and
     * must not name a cause it cannot observe.
     */
    it('keeps a transient probe failure retryable instead of blaming the setting', () => {
        const indicator = terminalRendererIndicator(status({ mode: 'dom', reason: 'unsupported' }));
        expect(indicator?.title).toBe(
            'Retry GPU rendering? — Terminal is using software rendering. The GPU is unavailable in this window right now.',
        );
    });

    /**
     * The same probe failure means something else once the app declined the GPU at boot: no re-probe in any window can
     * pass, so the chip has to stop offering one and hand over the Settings row that owns the preference (#983).
     */
    it('routes a boot-disabled window to Settings instead of an unwinnable retry', () => {
        const indicator = terminalRendererIndicator(
            status({ mode: 'dom', reason: 'unsupported' }),
            { isHardwareAccelerationOff: true },
        );
        expect(indicator?.action).toEqual({ opensSettings: true, title: 'Open Settings' });
        expect(indicator?.title).toBe(
            'Open Settings — Terminal is using software rendering. Hardware acceleration is turned off, so no Terminal in any window can use the GPU.',
        );
        // The flag only reinterprets the probe failure; a Terminal whose own setting is off still offers to turn it on.
        expect(
            terminalRendererIndicator(status({ mode: 'dom', reason: 'disabled' }), {
                isHardwareAccelerationOff: true,
            })?.action,
        ).toEqual(expect.objectContaining({ preference: 'on' }));
    });

    it('does not offer duplicate attempts during automatic recovery', () => {
        for (const retryState of ['scheduled', 'trying', 'deferred', 'failed'] as const) {
            expect(
                terminalRendererIndicator(
                    status({ mode: 'dom', reason: 'context-loss', retryState }),
                )?.action,
            ).toBeUndefined();
        }
    });
});

describe('TerminalRendererStatusRegistry', () => {
    it('unregisters retry handlers without removing a replacement mount', () => {
        const registry = new TerminalRendererStatusRegistry();
        const oldRetry = vi.fn(() => true);
        const newRetry = vi.fn(() => true);
        const removeOld = registry.registerRetry('t1', oldRetry);
        const removeNew = registry.registerRetry('t1', newRetry);
        removeOld();
        expect(registry.getRetry('t1')).toBe(newRetry);
        removeNew();
        expect(registry.getRetry('t1')).toBeUndefined();
    });
    it('publishes per Terminal and clears on dispose', () => {
        const registry = new TerminalRendererStatusRegistry();
        const listener = vi.fn();
        const unsubscribe = registry.subscribe('t1', listener);

        registry.publish('t1', status({ mode: 'dom', reason: 'disabled' }));
        expect(registry.get('t1')?.mode).toBe('dom');
        expect(listener).toHaveBeenCalledTimes(1);

        registry.publish('t2', status({}));
        expect(listener).toHaveBeenCalledTimes(1);

        registry.publish('t1', status({ mode: 'dom', reason: 'disposed', trigger: 'dispose' }));
        expect(registry.get('t1')).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(2);

        unsubscribe();
        registry.clear('t2');
        expect(registry.get('t2')).toBeUndefined();
    });

    it('notifies a later subscriber when an earlier one throws', () => {
        const registry = new TerminalRendererStatusRegistry();
        const failing = vi.fn(() => {
            throw new Error('renderer status listener failure');
        });
        const surviving = vi.fn();
        registry.subscribe('t1', failing);
        registry.subscribe('t1', surviving);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        registry.publish('t1', status({ mode: 'dom', reason: 'disabled' }));

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
    });
});
