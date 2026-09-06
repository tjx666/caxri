import type { DragEvent } from 'react';

import { describe, expect, it } from 'vitest';

import {
    dragPath,
    FILE_TREE_DRAG_TYPE,
    hasDraggedPath,
    shellRelativePath,
    terminalInputPath,
} from './file-drag';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), so a real
 * `DataTransfer`/`DragEvent` does not exist. Both helpers only ever touch `event.dataTransfer`, so a minimal fake
 * covering `getData` and `types` is enough to drive them deterministically.
 */
function fakeDragEvent(data: Record<string, string>): DragEvent {
    return {
        dataTransfer: {
            getData: (type: string) => data[type] ?? '',
            types: Object.keys(data),
        },
    } as unknown as DragEvent;
}

describe('dragPath', () => {
    it('reads back the path stored under the custom MIME type', () => {
        const event = fakeDragEvent({ [FILE_TREE_DRAG_TYPE]: '/repo/src/index.ts' });

        expect(dragPath(event)).toBe('/repo/src/index.ts');
    });

    it('returns undefined when the custom MIME type carries no path', () => {
        const event = fakeDragEvent({ 'text/plain': 'not a caxri drag' });

        expect(dragPath(event)).toBeUndefined();
    });

    it('returns undefined when the custom MIME type is present but empty', () => {
        const event = fakeDragEvent({ [FILE_TREE_DRAG_TYPE]: '' });

        expect(dragPath(event)).toBeUndefined();
    });
});

describe('hasDraggedPath', () => {
    it('is true when the drag carries the custom MIME type', () => {
        const event = fakeDragEvent({ [FILE_TREE_DRAG_TYPE]: '/repo/src/index.ts' });

        expect(hasDraggedPath(event)).toBe(true);
    });

    it('is false for an unrelated drag (e.g. dragging text or an external file)', () => {
        const event = fakeDragEvent({ 'text/plain': 'hello' });

        expect(hasDraggedPath(event)).toBe(false);
    });
});

describe('shellRelativePath', () => {
    it('makes a path inside the base directory relative', () => {
        expect(shellRelativePath('/repo/src/index.ts', '/repo')).toBe('src/index.ts');
        expect(shellRelativePath('/repo/src/index.ts', '/repo/')).toBe('src/index.ts');
    });

    it('spells the base directory itself as the current directory', () => {
        expect(shellRelativePath('/repo', '/repo')).toBe('.');
        expect(shellRelativePath('/repo/', '/repo')).toBe('.');
    });

    it('keeps paths outside the base and sibling-prefixed paths absolute', () => {
        expect(shellRelativePath('/other/file.ts', '/repo')).toBe('/other/file.ts');
        expect(shellRelativePath('/repo-two/file.ts', '/repo')).toBe('/repo-two/file.ts');
        expect(shellRelativePath('/repo/src/index.ts', '/repo/src/lib')).toBe('/repo/src/index.ts');
    });

    it('keeps the absolute path when no base directory is known', () => {
        expect(shellRelativePath('/repo/src/index.ts', undefined)).toBe('/repo/src/index.ts');
        expect(shellRelativePath('/repo/src/index.ts', '')).toBe('/repo/src/index.ts');
    });

    it('prefixes a relative path that would parse as a shell option', () => {
        expect(shellRelativePath('/repo/-rf', '/repo')).toBe('./-rf');
    });
});

describe('terminalInputPath', () => {
    it('keeps an ordinary absolute path readable', () => {
        expect(terminalInputPath('/repo/src/index.ts')).toBe('/repo/src/index.ts');
    });

    it('drops the Terminal working directory prefix and quotes the remainder when needed', () => {
        expect(terminalInputPath('/repo/src/index.ts', '/repo')).toBe('src/index.ts');
        expect(terminalInputPath("/repo/file with 'quote'.txt", '/repo')).toBe(
            String.raw`'file with '\''quote'\''.txt'`,
        );
    });

    it('quotes whitespace and shell metacharacters as one argument', () => {
        expect(terminalInputPath('/repo/a file;echo unsafe.txt')).toBe(
            "'/repo/a file;echo unsafe.txt'",
        );
    });

    it('closes and reopens the quote around an embedded single quote', () => {
        expect(terminalInputPath("/repo/file with 'quote'.txt")).toBe(
            String.raw`'/repo/file with '\''quote'\''.txt'`,
        );
    });
});
