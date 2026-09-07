import { afterEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, useToastStore } from '../stores/toasts';
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
        expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Path copied');

        await copyFilePath('/project/src/index.ts', '/project');
        expect(writeText).toHaveBeenLastCalledWith('src/index.ts');
        expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Relative path copied');
    });

    it('reports a path outside the selected Project without writing it', async () => {
        const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });

        await copyFilePath('/other/index.ts', '/project');

        expect(writeText).not.toHaveBeenCalled();
        expect(useToastStore.getState().toasts.at(-1)?.kind).toBe('error');
        expect(useToastStore.getState().toasts.at(-1)?.message).toContain('Path is outside');
    });
});
