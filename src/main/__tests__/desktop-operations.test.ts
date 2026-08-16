import { describe, expect, it, vi } from 'vitest';

import type { DesktopOperation, DesktopTargetPayload } from '../../shared/ipc/local-transport';
import { createDesktopOperationHandler } from '../desktop-operations';

const target: DesktopTargetPayload = {
    targetId: 'target-1',
    operation: 'open',
    kind: 'file',
    sessionId: 'session-1',
    path: '/project/file.ts',
};

function handlers() {
    return {
        focus: vi.fn(() => Promise.resolve()),
        open: vi.fn(),
        reveal: vi.fn(),
        status: vi.fn(() => 'background' as const),
    };
}

describe('createDesktopOperationHandler', () => {
    it('reports the window state for a status operation without touching the target', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.resolve(target));
        const handle = createDesktopOperationHandler(injected);

        await expect(handle({ kind: 'status' }, consumeTarget)).resolves.toEqual({
            state: 'background',
        });
        expect(injected.status).toHaveBeenCalledOnce();
        expect(consumeTarget).not.toHaveBeenCalled();
        expect(injected.focus).not.toHaveBeenCalled();
    });

    it('focuses the window for a focus operation and resolves to null', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.resolve(target));
        const handle = createDesktopOperationHandler(injected);

        await expect(handle({ kind: 'focus' }, consumeTarget)).resolves.toBeNull();
        expect(injected.focus).toHaveBeenCalledOnce();
        expect(consumeTarget).not.toHaveBeenCalled();
    });

    it('consumes the target and reveals its path without focusing the window', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.resolve(target));
        const handle = createDesktopOperationHandler(injected);

        await expect(
            handle({ kind: 'reveal', targetId: target.targetId }, consumeTarget),
        ).resolves.toBeNull();
        expect(consumeTarget).toHaveBeenCalledOnce();
        expect(injected.reveal).toHaveBeenCalledWith(target.path);
        expect(injected.focus).not.toHaveBeenCalled();
        expect(injected.open).not.toHaveBeenCalled();
    });

    it('focuses the window before opening a consumed target', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.resolve(target));
        const handle = createDesktopOperationHandler(injected);

        await expect(
            handle({ kind: 'open', targetId: target.targetId }, consumeTarget),
        ).resolves.toBeNull();
        expect(consumeTarget).toHaveBeenCalledOnce();
        expect(injected.open).toHaveBeenCalledWith(target);
        expect(injected.focus.mock.invocationCallOrder[0]).toBeLessThan(
            injected.open.mock.invocationCallOrder[0],
        );
    });

    it('propagates a target-consumption failure without invoking the reveal handler', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.reject(new Error('target expired')));
        const handle = createDesktopOperationHandler(injected);

        await expect(
            handle({ kind: 'reveal', targetId: target.targetId }, consumeTarget),
        ).rejects.toThrow('target expired');
        expect(injected.reveal).not.toHaveBeenCalled();
    });

    it('rejects an unrecognized operation kind instead of silently no-oping', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.resolve(target));
        const handle = createDesktopOperationHandler(injected);
        const unknownOperation = { kind: 'unknown' } as unknown as DesktopOperation;

        await expect(handle(unknownOperation, consumeTarget)).rejects.toMatchObject({
            code: 'INTERNAL',
        });
        expect(injected.status).not.toHaveBeenCalled();
        expect(injected.focus).not.toHaveBeenCalled();
        expect(injected.reveal).not.toHaveBeenCalled();
        expect(injected.open).not.toHaveBeenCalled();
    });
});
