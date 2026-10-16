import { describe, expect, it } from 'vitest';

import { fileLinkTarget, fileReferenceTarget, proseFileReferences } from '../file-reference.js';

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

describe('proseFileReferences', () => {
    it('keeps a quoted absolute path containing spaces as one complete reference', () => {
        const path = '/Users/me/Library/Application Support/Caxri/delegations/example.md';
        const text = `Read the delegated task from "${path}" and carry it out. Then see src/a.ts:4.`;
        expect(proseFileReferences(text)).toEqual([
            { index: text.indexOf(path), text: path, file: path },
            { index: text.indexOf('src/a.ts:4'), text: 'src/a.ts:4', file: 'src/a.ts:4' },
        ]);
    });

    it('finds paths and located names in prose, including flush against CJK text', () => {
        expect(
            proseFileReferences('Edited src/app.ts:12, /repo/a.md. 改了b.ts:3-5，再看 ./c.json'),
        ).toEqual([
            { index: 7, text: 'src/app.ts:12', file: 'src/app.ts:12' },
            { index: 22, text: '/repo/a.md', file: '/repo/a.md' },
            { index: 36, text: 'b.ts:3-5', file: 'b.ts#L3-L5' },
            { index: 48, text: './c.json', file: './c.json' },
        ]);
    });

    it.each([
        'Built with Node.js and index.ts as words',
        'https://example.com/src/a.ts',
        'mail me at a@example.com',
        'example.com/a.html',
        'pinned glm-5.3 and v1.2',
    ])('finds nothing in %j', (text) => {
        expect(proseFileReferences(text)).toEqual([]);
    });
});
