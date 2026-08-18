import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    isFolderGatedConflict,
    requestFileConflictChoice,
    resolveFileConflictChoice,
    useFileConflictDialogStore,
} from '../file-conflict-dialog-store';

describe('isFolderGatedConflict', () => {
    it('offers Replace only when both sides of the collision are plain files', () => {
        expect(isFolderGatedConflict('file', 'file')).toBe(false);
    });

    it('gates the folder path when either side is a directory', () => {
        expect(isFolderGatedConflict('directory', 'file')).toBe(true);
        expect(isFolderGatedConflict('file', 'directory')).toBe(true);
    });

    it('defaults to folder-gated when a side kind could not be resolved', () => {
        expect(isFolderGatedConflict(undefined, 'file')).toBe(true);
        expect(isFolderGatedConflict('file', undefined)).toBe(true);
    });
});

describe('requestFileConflictChoice / resolveFileConflictChoice', () => {
    beforeEach(() => {
        useFileConflictDialogStore.setState({ request: undefined, resolve: undefined });
    });

    it('opens the dialog with the given request', async () => {
        const promise = requestFileConflictChoice({ name: 'foo.txt', folderGated: false });

        expect(useFileConflictDialogStore.getState().request).toEqual({
            name: 'foo.txt',
            folderGated: false,
        });

        resolveFileConflictChoice('replace');
        await expect(promise).resolves.toBe('replace');
    });

    it('resolves the pending prompt and closes the dialog', async () => {
        const promise = requestFileConflictChoice({ name: 'foo.txt', folderGated: false });

        resolveFileConflictChoice('keep-both');

        await expect(promise).resolves.toBe('keep-both');
        expect(useFileConflictDialogStore.getState().request).toBeUndefined();
        expect(useFileConflictDialogStore.getState().resolve).toBeUndefined();
    });

    it('resolves a stale pending request as canceled when a new one arrives', async () => {
        const stale = requestFileConflictChoice({ name: 'first.txt', folderGated: false });
        const fresh = requestFileConflictChoice({ name: 'second.txt', folderGated: false });

        await expect(stale).resolves.toBe('cancel');
        expect(useFileConflictDialogStore.getState().request).toEqual({
            name: 'second.txt',
            folderGated: false,
        });

        resolveFileConflictChoice('replace');
        await expect(fresh).resolves.toBe('replace');
    });

    it('is a no-op once the pending request is already resolved', () => {
        const resolve = vi.fn();
        useFileConflictDialogStore.setState({
            request: { name: 'foo.txt', folderGated: false },
            resolve,
        });

        resolveFileConflictChoice('cancel');
        resolve.mockClear();
        // A second resolve call must not invoke a stale resolver or throw, because the store has
        // already cleared its `resolve` reference.
        resolveFileConflictChoice('replace');

        expect(resolve).not.toHaveBeenCalled();
    });
});
