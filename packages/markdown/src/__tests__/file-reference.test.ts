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
        ['/repo/.local-config', '/repo/.local-config'],
        ['~/x/.env', '~/x/.env'],
        ['/repo/Makefile:3', '/repo/Makefile:3'],
        ['/repo/my.app/sub', '/repo/my.app/sub'],
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
        '/model',
        '/btw',
        '~/notes',
        '/',
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

    it('links a rooted extensionless path written flush against CJK text', () => {
        expect(proseFileReferences('/Users/me/code/project/.local-config 拉一下最新配置')).toEqual([
            {
                index: 0,
                text: '/Users/me/code/project/.local-config',
                file: '/Users/me/code/project/.local-config',
            },
        ]);
    });

    it('links rooted dotfiles, extensionless files, and home paths with locations', () => {
        expect(proseFileReferences('see ~/x/.env and /repo/Makefile:3')).toEqual([
            { index: 4, text: '~/x/.env', file: '~/x/.env' },
            { index: 17, text: '/repo/Makefile:3', file: '/repo/Makefile:3' },
        ]);
    });

    it('leaves the sentence-ending period outside an extensionless path', () => {
        expect(proseFileReferences('It lives in /repo/dir.')).toEqual([
            { index: 12, text: '/repo/dir', file: '/repo/dir' },
        ]);
    });

    it('does not link slash commands or relative extensionless paths', () => {
        expect(proseFileReferences('Run /model then /btw, edit apps/desktop')).toEqual([]);
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

    it('keeps a quoted rooted path whole across its spaces', () => {
        const path = '/Users/me/Library/Application Support/Caxri/task.md';
        expect(proseFileReferences(`Read "${path}" and then src/a.ts`)).toEqual([
            { index: 6, text: path, file: path },
            { index: 68, text: 'src/a.ts', file: 'src/a.ts' },
        ]);
        expect(proseFileReferences("open '~/My Notes/plan.md:3-5'")).toEqual([
            { index: 6, text: '~/My Notes/plan.md:3-5', file: '~/My Notes/plan.md#L3-L5' },
        ]);
    });

    it('leaves quoted prose and unrooted names with spaces alone', () => {
        expect(proseFileReferences('"hello world.md" and "/a b/c" and "just words"')).toEqual([]);
    });
});
