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

const CORRELATION_ID = '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae';

const ACTIVE_WEBGL_STATUS: TerminalRendererStatus = {
    contextLossCount: 0,
    mode: 'webgl',
    reason: 'active',
    recoveryResult: 'not-requested',
    redrawCount: 0,
    trigger: 'preference-change',
};

const GLOBAL_RECOVERY_STATUS: TerminalRendererStatus = {
    contextLossCount: 1,
    mode: 'dom',
    reason: 'context-loss',
    recoveryResult: 'dom-restored',
    redrawCount: 1,
    trigger: 'gpu-process-recovery',
};

function createObserver() {
    const container = {
        contains: () => false,
        dataset: {},
    } as unknown as HTMLElement;
    return createTerminalRendererObserver({
        container,
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
});
