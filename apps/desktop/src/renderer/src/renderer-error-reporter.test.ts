import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installRendererErrorReporter } from './renderer-error-reporter';

/**
 * `installRendererErrorReporter` calls the bare global `addEventListener` (see the source's own comment about
 * `contextBridge`-safe wiring) and never reads the event object it receives, so a stub global capturing registered
 * listeners is enough to drive it deterministically without a real `ErrorEvent`/`PromiseRejectionEvent`, following
 * `lib/motion.test.ts`'s stub-the-missing-global approach for this repository's `node` test environment (see
 * `vitest.config.ts`).
 */
type Listener = (event?: unknown) => void;

const addEventListener = vi.fn<(type: string, listener: Listener) => void>();

beforeEach(() => {
    addEventListener.mockReset();
    vi.stubGlobal('addEventListener', addEventListener);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function listenerFor(type: string): Listener {
    const call = addEventListener.mock.calls.find(([registeredType]) => registeredType === type);
    if (!call) throw new Error(`no listener registered for ${type}`);
    return call[1];
}

describe('installRendererErrorReporter', () => {
    it('registers exactly one error listener and one unhandledrejection listener', () => {
        installRendererErrorReporter(vi.fn());

        expect(addEventListener).toHaveBeenCalledTimes(2);
        expect(addEventListener).toHaveBeenCalledWith('error', expect.any(Function));
        expect(addEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
    });

    it('maps a window error event to the page-exception kind', () => {
        const report = vi.fn();
        installRendererErrorReporter(report);

        listenerFor('error')();

        expect(report).toHaveBeenCalledExactlyOnceWith('page-exception');
    });

    it('does not report Chromium ResizeObserver delivery warnings as page exceptions', () => {
        const report = vi.fn();
        installRendererErrorReporter(report);

        listenerFor('error')({
            message: 'ResizeObserver loop completed with undelivered notifications.',
        });

        expect(report).not.toHaveBeenCalled();
    });

    it('maps an unhandledrejection event to the unhandled-rejection kind', () => {
        const report = vi.fn();
        installRendererErrorReporter(report);

        listenerFor('unhandledrejection')();

        expect(report).toHaveBeenCalledExactlyOnceWith('unhandled-rejection');
    });

    it('never conflates the two event kinds', () => {
        const report = vi.fn();
        installRendererErrorReporter(report);

        listenerFor('error')();
        listenerFor('unhandledrejection')();

        expect(report).toHaveBeenNthCalledWith(1, 'page-exception');
        expect(report).toHaveBeenNthCalledWith(2, 'unhandled-rejection');
    });
});
