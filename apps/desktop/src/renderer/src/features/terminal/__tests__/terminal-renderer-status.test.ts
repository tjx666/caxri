import { describe, expect, it, vi } from 'vitest';

import type { TerminalRendererStatus } from '../terminal-renderer';
import {
    terminalRendererIndicator,
    TerminalRendererStatusRegistry,
} from '../terminal-renderer-status';

function status(overrides: Partial<TerminalRendererStatus>): TerminalRendererStatus {
    return {
        contextLossCount: 0,
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

    it('explains why the DOM renderer is active', () => {
        expect(terminalRendererIndicator(status({ mode: 'dom', reason: 'disabled' }))).toEqual({
            action: {
                confirmLabel: 'Turn On',
                message:
                    'Terminals switch from the DOM renderer to WebGL immediately, without restarting Caxri or the Terminal. You can turn it off again in Settings.',
                preference: 'on',
                title: 'Turn on GPU acceleration?',
            },
            ariaLabel:
                'Turn on GPU acceleration? — Terminal renderer: DOM. GPU acceleration is turned off in Settings.',
            label: 'DOM',
            title: 'Turn on GPU acceleration? — Terminal is using the DOM renderer. GPU acceleration is turned off in Settings.',
        });
        expect(
            terminalRendererIndicator(status({ mode: 'dom', reason: 'unsupported' }))?.title,
        ).toContain('WebGL2 is unavailable');
        expect(
            terminalRendererIndicator(
                status({
                    contextLossCount: 1,
                    mode: 'dom',
                    reason: 'context-loss',
                    retryAttemptCount: 1,
                    retryState: 'scheduled',
                }),
            )?.title,
        ).toBe(
            'Terminal is using the DOM renderer. The WebGL context was lost. Retrying WebGL (1/3).',
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

    it('explains a session pinned to DOM after repeated GPU incidents', () => {
        expect(
            terminalRendererIndicator(status({ mode: 'dom', reason: 'context-loss-limit' }))?.title,
        ).toBe(
            'Terminal is using the DOM renderer. The GPU process crashed repeatedly; WebGL stays off until GPU acceleration is changed in Settings or Caxri restarts.',
        );
    });

    it('offers the switch only for the preference-driven fallback the chip can reverse', () => {
        expect(
            terminalRendererIndicator(status({ mode: 'dom', reason: 'disabled' }))?.action
                ?.preference,
        ).toBe('on');
        for (const reason of [
            'unsupported',
            'context-loss',
            'context-loss-limit',
            'load-failed',
        ] as const) {
            const indicator = terminalRendererIndicator(status({ mode: 'dom', reason }));
            expect(indicator?.action).toBeUndefined();
            // A read-only chip must not promise an action in its accessible name or tooltip.
            expect(indicator?.ariaLabel).toBe(
                `Terminal renderer: DOM. ${indicator?.title.replace('Terminal is using the DOM renderer. ', '')}`,
            );
        }
    });
});

describe('TerminalRendererStatusRegistry', () => {
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
});
