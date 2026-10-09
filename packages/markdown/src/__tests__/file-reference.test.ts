import { describe, expect, it } from 'vitest';

import { fileLinkTarget, fileReferenceTarget } from '../file-reference.js';

describe('fileReferenceTarget', () => {
    it.each([
        ['src/app.tsx', 'src/app.tsx'],
        ['./a.ts:12:3', './a.ts:12:3'],
        ['/repo/a.ts#L3-L9', '/repo/a.ts#L3-L9'],
        ['packages/a.ts:10-20', 'packages/a.ts#L10-L20'],
        ['package.json', 'package.json'],
        ['schema.proto:4', 'schema.proto:4'],
    ])('reads %j as a file', (value, expected) => {
        expect(fileReferenceTarget(value)).toBe(expected);
    });

    it.each([
        'console.log',
        'user.name',
        'example.com/a.html',
        'example.com:443',
        'glm-5.3',
        'https://example.com/a.ts',
        'bun run test',
        'apps/desktop',
    ])('does not read %j as a file', (value) => {
        expect(fileReferenceTarget(value)).toBeUndefined();
    });
});

describe('fileLinkTarget', () => {
    it.each([
        ['/repo/a.ts:12', '/repo/a.ts:12'],
        ['file:///repo/a%20b.md', '/repo/a b.md'],
        ['src/%E4%B8%AD.ts', 'src/中.ts'],
    ])('reads %j as a local file', (destination, expected) => {
        expect(fileLinkTarget(destination)).toBe(expected);
    });

    it.each(['mailto:a@example.com', '#heading', 'vscode://file/a.ts'])(
        'does not read %j as a local file',
        (destination) => {
            expect(fileLinkTarget(destination)).toBeUndefined();
        },
    );
});
