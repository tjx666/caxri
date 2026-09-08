import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, getToasts } from '../stores/toasts';
import { copyFilePath } from './copy-file-path';

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
