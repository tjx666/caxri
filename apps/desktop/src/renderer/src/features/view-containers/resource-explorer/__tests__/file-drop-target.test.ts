import type { FileEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { fileTreeDropDirectory } from '../file-drop-target';

const entry = (kind: FileEntry['kind'], path: string): FileEntry => ({ kind, name: 'x', path });

describe('fileTreeDropDirectory', () => {
    it('drops on a directory row into that directory', () => {
        expect(fileTreeDropDirectory(entry('directory', '/p/src'))).toBe('/p/src');
    });

    it('drops on a file row into its parent directory', () => {
        expect(fileTreeDropDirectory(entry('file', '/p/src/a.ts'))).toBe('/p/src');
    });

    it('leaves a symlink row to the tree container', () => {
        expect(fileTreeDropDirectory(entry('symlink', '/p/link'))).toBeUndefined();
    });
});
