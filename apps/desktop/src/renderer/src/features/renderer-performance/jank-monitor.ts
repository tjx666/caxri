import { RendererJankReporter } from './jank-reporter';

const installation: { reporter?: RendererJankReporter } = {};

/**
 * Starts the always-on, threshold-gated responsiveness log: Long Animation Frames of 100 ms or more and slow Session
 * switches are batched and sent to Desktop Main over the Renderer diagnostic channel, which writes `renderer.jank`.
 * Chromium only delivers a Long Animation Frame entry from 50 ms, so a healthy Renderer wakes this observer rarely and
 * sends nothing. Safe to call more than once; where the API or the bridge is missing it does nothing.
 */
export function installRendererJankMonitor(): void {
    if (typeof PerformanceObserver === 'undefined' || installation.reporter) return;
    if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) return;
    const installed = new RendererJankReporter({
        clearTimer: (handle) => clearTimeout(handle as number),
        isDocumentVisible: () => document.visibilityState === 'visible',
        newId: () => crypto.randomUUID(),
        now: () => performance.now(),
        report: (diagnostic) => globalThis.caxri.reportDiagnostic(diagnostic),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    });
    new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) installed.recordFrame(entry);
    }).observe({ type: 'long-animation-frame', buffered: false });
    // A hidden window may be closed or suspended before the batch timer fires.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') installed.flushIfDue();
    });
    installation.reporter = installed;
}

/**
 * Times one Session switch: the select gesture to the first frame presented after the Workbench applied the result.
 * Call `replied` when the Server answered, `converged` when the new state was applied, and `abandon` when the switch
 * failed. Does nothing until {@link installRendererJankMonitor} ran or while the window is hidden.
 */
export function beginSessionSwitchTiming(): {
    abandon(): void;
    converged(): void;
    replied(): void;
} {
    const active = installation.reporter;
    if (!active || document.visibilityState !== 'visible')
        return { abandon() {}, converged() {}, replied() {} };
    const startedAt = performance.now();
    let repliedAt = startedAt;
    let isDone = false;
    return {
        abandon() {
            isDone = true;
        },
        replied() {
            repliedAt = performance.now();
        },
        converged() {
            if (isDone) return;
            isDone = true;
            const convergedAt = performance.now();
            // Two frames: the first commits the new Session, the second runs after it was presented.
            requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                    active.recordSessionSwitch({
                        startedAt,
                        repliedAt,
                        convergedAt,
                        paintedAt: performance.now(),
                    }),
                ),
            );
        },
    };
}
