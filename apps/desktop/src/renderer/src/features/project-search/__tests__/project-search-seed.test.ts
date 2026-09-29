import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTextSelectionSource } from '../../../lib/focused-text-selection';
import {
    projectSearchFolderInclude,
    projectSearchSeedQuery,
    resolveProjectSearchSeedQuery,
} from '../project-search-seed';

describe('projectSearchSeedQuery', () => {
    it('trims a single-line term', () => {
        expect(projectSearchSeedQuery('  useProjectSearch\n')).toBe('useProjectSearch');
    });

    it('refuses empty, multi-line, and oversized text', () => {
        expect(projectSearchSeedQuery(' '.repeat(3))).toBeUndefined();
        expect(projectSearchSeedQuery('first\nsecond')).toBeUndefined();
        expect(projectSearchSeedQuery('x'.repeat(201))).toBeUndefined();
    });
});

describe('resolveProjectSearchSeedQuery', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        for (const cleanup of cleanups) cleanup();
        cleanups.length = 0;
        vi.unstubAllGlobals();
    });

    /**
     * This suite runs under `node`, so the focused surface is modelled by the two DOM members the reader touches.
     */
    function focusedSource(selection: string): void {
        const active = {};
        vi.stubGlobal('document', { activeElement: active });
        vi.stubGlobal('getSelection', () => null);
        const element = { contains: (node: unknown) => node === active } as HTMLElement;
        cleanups.push(registerTextSelectionSource(element, () => selection));
    }

    it('prefers the focused surface selection over the clipboard', async () => {
        focusedSource('selectedTerm');
        const readClipboard = vi.fn(() => Promise.resolve('clipboardTerm'));
        await expect(resolveProjectSearchSeedQuery(readClipboard)).resolves.toBe('selectedTerm');
        expect(readClipboard).not.toHaveBeenCalled();
    });

    it('falls back to the clipboard when nothing usable is selected', async () => {
        focusedSource('');
        await expect(
            resolveProjectSearchSeedQuery(() => Promise.resolve('clipboardTerm')),
        ).resolves.toBe('clipboardTerm');
    });

    it('seeds nothing when the clipboard is unreadable or holds a block of text', async () => {
        focusedSource('');
        await expect(
            resolveProjectSearchSeedQuery(() => {
                return Promise.reject(new Error('denied'));
            }),
        ).resolves.toBeUndefined();
        await expect(
            resolveProjectSearchSeedQuery(() => Promise.resolve('a\nb')),
        ).resolves.toBeUndefined();
    });
});

describe('projectSearchFolderInclude', () => {
    it('matches every descendant of a directory and nothing for the Project root', () => {
        expect(projectSearchFolderInclude('src/features')).toBe('src/features/**');
        expect(projectSearchFolderInclude('.')).toBe('');
    });
});
