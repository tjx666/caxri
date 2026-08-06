import { describe, expect, it } from 'vitest';

import { parentDirectoryPath } from './file-tree-refresh';

describe('file tree refresh routing', () => {
    it('routes each changed path to the directory that directly owns it', () => {
        expect(parentDirectoryPath('/project/src')).toBe('/project');
        expect(parentDirectoryPath('/project/src/index.ts')).toBe('/project/src');
        expect(parentDirectoryPath('/file.ts')).toBe('/');
    });
});
