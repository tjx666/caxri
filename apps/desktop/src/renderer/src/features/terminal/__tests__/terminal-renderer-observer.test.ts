import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalRendererStatus } from '../terminal-renderer';

const mocks = vi.hoisted(() => ({
    disposeTerminal: vi.fn(),
    observeTerminalRendererStatus: vi.fn(),
    reportDiagnostic: vi.fn(),
    showGpuRecoveryToast: vi.fn(),
}));

vi.mock('../../gpu/gpu-recovery-notifications', () => ({
    gpuRecoveryNotificationCoordinator: {
        disposeTerminal: mocks.disposeTerminal,
        observeTerminalRendererStatus: mocks.observeTerminalRendererStatus,
    },
    showGpuRecoveryToast: mocks.showGpuRecoveryToast,
}));

import { createTerminalRendererObserver } from '../terminal-renderer-observer';
import { getTerminalRendererRetry } from '../terminal-renderer-status';

const CORRELATION_ID = '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae';

const ACTIVE_WEBGL_STATUS: TerminalRendererStatus = {
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
};

const GLOBAL_RECOVERY_STATUS: TerminalRendererStatus = {
    contextLossCount: 1,
    liveWebglContextCount: 1,
    mode: 'dom',
    reason: 'context-loss',
    recoveryResult: 'dom-restored',
    redrawCount: 1,
    retryAttemptCount: 0,
    retryDelayMs: 1_000,
    retryLimit: 3,
    retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
    retryState: 'scheduled',
    trigger: 'gpu-process-recovery',
};

const RETRY_SUCCEEDED_STATUS: TerminalRendererStatus = {
    contextLossCount: 1,
    liveWebglContextCount: 1,
    mode: 'webgl',
    reason: 'active',
    recoveryResult: 'not-requested',
    redrawCount: 2,
    retryAttemptCount: 1,
    retryDelayMs: null,
    retryLimit: 3,
    retrySequenceId: '5bb3b253-1200-427b-88b3-83f70d21f360',
    retryState: 'succeeded',
    trigger: 'webgl-retry-succeeded',
};

function createObserver() {
    const container = {
        contains: () => false,
        dataset: {},
    } as unknown as HTMLElement;
    return createTerminalRendererObserver({
        container,
        retry: () => true,
        current: () => ({
            active: true,
            gpuAcceleration: 'on',
            isAgent: false,
            processState: 'running',
        }),
        terminalId: 'terminal-1',
    });
}

beforeEach(() => {
    mocks.disposeTerminal.mockClear();
    mocks.observeTerminalRendererStatus.mockClear();
    mocks.reportDiagnostic.mockClear();
    mocks.showGpuRecoveryToast.mockClear();
    vi.stubGlobal('caxri', { reportDiagnostic: mocks.reportDiagnostic });
    vi.stubGlobal('document', {
        activeElement: undefined,
        hasFocus: () => true,
        visibilityState: 'visible',
    });
});

it('registers manual recovery for the mounted pane and removes it on disposal', () => {
    const observer = createObserver();
    expect(getTerminalRendererRetry('terminal-1')?.()).toBe(true);
    observer.dispose();
    expect(getTerminalRendererRetry('terminal-1')).toBeUndefined();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Terminal renderer observer GPU notification routing', () => {
    it('releases notification state when the mounted observer is disposed', () => {
        const observer = createObserver();

        observer.dispose();

        expect(mocks.disposeTerminal).toHaveBeenCalledWith('terminal-1');
    });

    it('passes every renderer status to the shared notification coordinator', () => {
        const observer = createObserver();

        observer.publish(ACTIVE_WEBGL_STATUS);
        observer.publish(GLOBAL_RECOVERY_STATUS);

        expect(mocks.observeTerminalRendererStatus).toHaveBeenCalledTimes(2);
        expect(mocks.observeTerminalRendererStatus).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                status: ACTIVE_WEBGL_STATUS,
                terminalId: 'terminal-1',
            }),
        );
        expect(mocks.observeTerminalRendererStatus).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                status: GLOBAL_RECOVERY_STATUS,
                terminalId: 'terminal-1',
            }),
        );
        expect(mocks.showGpuRecoveryToast).not.toHaveBeenCalled();
    });

    it('preserves the global correlation in both notification input and diagnostics', () => {
        const observer = createObserver();

        observer.withRecovery(CORRELATION_ID, () => observer.publish(GLOBAL_RECOVERY_STATUS));

        expect(mocks.observeTerminalRendererStatus).toHaveBeenCalledWith(
            expect.objectContaining({
                correlationId: CORRELATION_ID,
                status: GLOBAL_RECOVERY_STATUS,
                terminalId: 'terminal-1',
            }),
        );
        expect(mocks.reportDiagnostic).toHaveBeenCalledWith(
            expect.objectContaining({
                correlationId: CORRELATION_ID,
                terminalId: 'terminal-1',
                trigger: 'gpu-process-recovery',
            }),
        );
    });

    it('keeps the GPU incident correlation through a delayed retry and clears it after success', () => {
        const observer = createObserver();

        observer.withRecovery(CORRELATION_ID, () => observer.publish(GLOBAL_RECOVERY_STATUS));
        observer.publish(RETRY_SUCCEEDED_STATUS);
        observer.publish(ACTIVE_WEBGL_STATUS);

        expect(mocks.reportDiagnostic).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                correlationId: CORRELATION_ID,
                retrySequenceId: RETRY_SUCCEEDED_STATUS.retrySequenceId,
                retryState: 'succeeded',
            }),
        );
        expect(mocks.reportDiagnostic.mock.calls[2]?.[0]).not.toHaveProperty('correlationId');
    });
});
