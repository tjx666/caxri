import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, getToasts } from '../stores/toasts';
import { copyFileName, copyFilePath, relativePathRoot } from './copy-file-path';

describe('relativePathRoot', () => {
    it.each([
        { basis: 'a plain file', path: '/project/src/index.ts' },
        { basis: 'a submodule file', path: '/project/vendor/sub/src/index.ts' },
        { basis: 'a nested repository file', path: '/project/packages/nested/lib/a.ts' },
    ])('measures $basis from the Project root even with its own repository', ({ path }) => {
        expect(relativePathRoot(path, '/project')).toBe('/project');
        expect(relativePathRoot(path, '/project', '/project/vendor/sub')).toBe('/project');
    });

    it('keeps the repository root only for a resource the Project does not contain', () => {
        expect(
            relativePathRoot('/elsewhere/linked/src/a.ts', '/project', '/elsewhere/linked'),
        ).toBe('/elsewhere/linked');
        expect(relativePathRoot('/elsewhere/linked/src/a.ts', '/project')).toBeUndefined();
        expect(relativePathRoot('/elsewhere/linked/src/a.ts', undefined)).toBeUndefined();
    });
});

describe('copyFilePath', () => {
    afterEach(() => {
        dismissToast();
        vi.unstubAllGlobals();
    });

    it('copies absolute and Project-relative paths with matching success messages', async () => {
        const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });

        await copyFilePath('/project/src/index.ts');
        expect(writeText).toHaveBeenLastCalledWith('/project/src/index.ts');
        expect(getToasts().at(-1)?.title).toBe('Path copied');

        await copyFilePath('/project/src/index.ts', '/project');
        expect(writeText).toHaveBeenLastCalledWith('src/index.ts');
        expect(getToasts().at(-1)?.title).toBe('Relative path copied');
    });

    it('reports a path outside the selected Project without writing it', async () => {
        const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });

        await copyFilePath('/other/index.ts', '/project');

        expect(writeText).not.toHaveBeenCalled();
        expect(getToasts().at(-1)?.type).toBe('error');
        expect(getToasts().at(-1)?.title).toContain('Path is outside');
    });
});

describe('copyFileName', () => {
    afterEach(() => {
        dismissToast();
        vi.unstubAllGlobals();
    });

    it('copies only the final path segment', async () => {
        const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });

        await copyFileName('/project/src/notes.ts');

        expect(writeText).toHaveBeenLastCalledWith('notes.ts');
        expect(getToasts().at(-1)?.title).toBe('Name copied');
    });
});
