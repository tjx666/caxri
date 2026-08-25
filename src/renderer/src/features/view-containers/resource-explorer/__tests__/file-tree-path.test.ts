import { describe, expect, it } from 'vitest';

import { parentDirectoryPath } from '../file-tree-path';

describe('file tree paths', () => {
    it('resolves the directory that directly owns an absolute path', () => {
        expect(parentDirectoryPath('/project/src')).toBe('/project');
        expect(parentDirectoryPath('/project/src/index.ts')).toBe('/project/src');
        expect(parentDirectoryPath('/file.ts')).toBe('/');
    });
});
