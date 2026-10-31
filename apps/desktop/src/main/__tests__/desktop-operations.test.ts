import type { DesktopOperation, DesktopTargetPayload } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

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
        confirmGitDiscard: vi.fn(() => Promise.resolve(true)),
        focus: vi.fn(() => Promise.resolve()),
        open: vi.fn(),
        openInEditor: vi.fn(() => Promise.resolve()),
        openWithDefaultApp: vi.fn(() => Promise.resolve()),
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

    it('hands a consumed target to the default application without focusing the window', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.resolve(target));
        const handle = createDesktopOperationHandler(injected);

        await expect(
            handle({ kind: 'openWithDefaultApp', targetId: target.targetId }, consumeTarget),
        ).resolves.toBeNull();
        expect(consumeTarget).toHaveBeenCalledOnce();
        expect(injected.openWithDefaultApp).toHaveBeenCalledWith(target.path);
        expect(injected.focus).not.toHaveBeenCalled();
        expect(injected.open).not.toHaveBeenCalled();
    });

    it('surfaces a refused default-application launch as a rejection', async () => {
        const injected = handlers();
        injected.openWithDefaultApp = vi.fn(() =>
            Promise.reject(new Error('No application is registered')),
        );
        const handle = createDesktopOperationHandler(injected);

        await expect(
            handle(
                { kind: 'openWithDefaultApp', targetId: target.targetId },
                vi.fn(() => Promise.resolve(target)),
            ),
        ).rejects.toThrow('No application is registered');
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

    it('launches the external editor carried by the openInEditor command without focusing', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.resolve(target));
        const handle = createDesktopOperationHandler(injected);

        await expect(
            handle(
                { kind: 'openInEditor', targetId: target.targetId, editorCommand: 'code' },
                consumeTarget,
            ),
        ).resolves.toBeNull();
        expect(consumeTarget).toHaveBeenCalledOnce();
        // The command travels with the operation; Main must never request it back from Server Core
        // while it is still holding that connection's ordered queue open.
        expect(injected.openInEditor).toHaveBeenCalledWith(target.path, 'code');
        expect(injected.focus).not.toHaveBeenCalled();
        expect(injected.open).not.toHaveBeenCalled();
    });

    it('passes an undefined editor command through when none is configured', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.resolve(target));
        const handle = createDesktopOperationHandler(injected);

        await expect(
            handle({ kind: 'openInEditor', targetId: target.targetId }, consumeTarget),
        ).resolves.toBeNull();
        expect(injected.openInEditor).toHaveBeenCalledWith(target.path, undefined);
    });

    it('returns the bounded Git confirmation without consuming a target', async () => {
        const injected = handlers();
        const consumeTarget = vi.fn(() => Promise.resolve(target));
        const handle = createDesktopOperationHandler(injected);
        const target_ = {
            repositoryName: 'project',
            scope: { kind: 'all' as const, fileCount: 2 },
        };

        await expect(
            handle({ kind: 'confirmGitDiscard', target: target_ }, consumeTarget),
        ).resolves.toEqual({ confirmed: true });
        expect(injected.confirmGitDiscard).toHaveBeenCalledWith(target_);
        expect(consumeTarget).not.toHaveBeenCalled();
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
        expect(injected.openWithDefaultApp).not.toHaveBeenCalled();
    });

    it('hands an update operation to the update handler', async () => {
        const update = vi.fn(() => Promise.resolve({ status: 'idle', currentVersion: '1.0.0' }));
        const handle = createDesktopOperationHandler({ ...handlers(), update });
        const operation: DesktopOperation = { kind: 'update', action: 'read' };

        await expect(handle(operation, vi.fn())).resolves.toEqual({
            status: 'idle',
            currentVersion: '1.0.0',
        });
        expect(update).toHaveBeenCalledWith(operation);
    });

    it('answers unsupported for an update where Desktop owns no app update', async () => {
        const handle = createDesktopOperationHandler(handlers());

        await expect(handle({ kind: 'update', action: 'read' }, vi.fn())).resolves.toEqual({
            unsupported: true,
        });
    });
});
