import { describe, expect, it, vi } from 'vitest';

import { NativeFileOperations, type NativeProjectEntry } from '../native-file-operations';

describe('NativeFileOperations', () => {
    it('does not give the parent a kill timeout for a staged move transaction', async () => {
        const runner = vi.fn(() => Promise.resolve());
        const root = { device: '1', inode: '2', path: '/project' };
        const source: NativeProjectEntry = {
            device: '1',
            inode: '3',
            path: '/project/source.txt',
            root,
        };
        const directory: NativeProjectEntry = {
            device: '1',
            inode: '2',
            path: '/project',
            root,
        };
        const operations = new NativeFileOperations('/helper', runner);

        await operations.move(source, directory, 'target.txt');

        expect(runner).toHaveBeenCalledOnce();
        expect(runner).toHaveBeenCalledWith(
            '/helper',
            ['move', '/project', '1', '2', 'source.txt', '1', '3', '.', '1', '2', 'target.txt'],
            { windowsHide: true },
        );
    });
});
