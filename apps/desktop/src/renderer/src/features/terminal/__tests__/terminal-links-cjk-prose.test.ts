import { describe, expect, it } from 'vitest';

import { findTerminalLinks } from '../terminal-links';

/**
 * Plain-text file candidates glued to CJK prose, including location links parsed before word tokenization.
 */
describe('findTerminalLinks with CJK prose', () => {
    it.each(Array.from('，。；：！？、（）【】「」『』《》'))(
        'separates adjacent fallback file links at %s',
        (separator) => {
            expect(findTerminalLinks(`src/first.ts${separator}src/second.ts`)).toMatchObject([
                { kind: 'file', target: 'src/first.ts' },
                { kind: 'file', target: 'src/second.ts' },
            ]);
        },
    );

    it('separates enumerated location links at a CJK boundary', () => {
        // Regression: the location parser walks back to whitespace, so an enumeration comma between two
        // paths was folded into one target such as `src/a.ts:10, src/b.ts`.
        expect(findTerminalLinks('修改了 src/a.ts:10、src/b.ts:20 两处')).toMatchObject([
            { kind: 'file', startIndex: 4, target: 'src/a.ts', location: { startLine: 10 } },
            { kind: 'file', startIndex: 16, target: 'src/b.ts', location: { startLine: 20 } },
        ]);
        expect(findTerminalLinks('src/a.ts、src/b.ts:20')).toMatchObject([
            { kind: 'file', target: 'src/a.ts' },
            { kind: 'file', target: 'src/b.ts', location: { startLine: 20 } },
        ]);
        expect(findTerminalLinks('src/a.ts#L3、src/b.ts#L9')).toMatchObject([
            { kind: 'file', target: 'src/a.ts', location: { startLine: 3 } },
            { kind: 'file', target: 'src/b.ts', location: { startLine: 9 } },
        ]);
        expect(findTerminalLinks('src/a.ts:1、docs/目录。版本/file.ts:8')).toMatchObject([
            { kind: 'file', target: 'src/a.ts', location: { startLine: 1 } },
            { kind: 'file', target: 'docs/目录。版本/file.ts', location: { startLine: 8 } },
        ]);
    });

    it.each([':', '：'])('detaches a CJK label ending in %s from a relative path', (separator) => {
        const prefix = `字段说明${separator}`;
        for (const suffix of ['', ':57', ':57:3', '#L57-L59']) {
            const path = `src/example.ts${suffix}`;
            expect(findTerminalLinks(`${prefix}${path} 的字段`)).toMatchObject([
                {
                    startIndex: prefix.length,
                    endIndex: prefix.length + path.length,
                    target: 'src/example.ts',
                    text: path,
                },
            ]);
        }
    });

    it('detaches a full-width label colon when persisted word separators omit CJK punctuation', () => {
        const persistedSeparators = ' ()[]{}\',"`─‘’“”|';
        const prefix = 'Model Config：';
        const path = '.local-config/example_model_config.assembled.json';

        expect(findTerminalLinks(`${prefix}${path}`, persistedSeparators)).toEqual([
            {
                endIndex: prefix.length + path.length,
                kind: 'file',
                startIndex: prefix.length,
                target: path,
                text: path,
            },
        ]);
        expect(findTerminalLinks('docs：v2/file.ts', persistedSeparators)).toMatchObject([
            { kind: 'file', target: 'docs：v2/file.ts' },
        ]);
        expect(findTerminalLinks('字段说明：src/example.ts', persistedSeparators)).toMatchObject([
            { kind: 'file', target: 'src/example.ts' },
        ]);
        expect(
            findTerminalLinks('Model Config：~/example/path.json:7', persistedSeparators),
        ).toMatchObject([
            {
                kind: 'file',
                target: '~/example/path.json',
                location: { mode: 'line', startLine: 7, endLine: 7 },
            },
        ]);
    });

    it('preserves colons inside explicit paths and file URLs', () => {
        for (const path of ['./说明:src/example.ts', 'docs/说明:目录/example.ts']) {
            expect(findTerminalLinks(`${path}:57`)).toMatchObject([
                { target: path, location: { startLine: 57, endLine: 57 } },
            ]);
        }
        expect(findTerminalLinks('file:///src/example.ts')).toMatchObject([
            { target: 'file:///src/example.ts' },
        ]);
    });

    it('splits a path from glued CJK prose at a word-separator parenthesis', () => {
        // Regression: `realpath '/…/串联 (src/api/workflows/es-reindex.ts)'` ENOENT: the CJK
        // prefix and wrapping parentheses were folded into the clicked path.
        expect(findTerminalLinks('串联 (src/api/workflows/es-reindex.ts) 已完成')).toEqual([
            {
                endIndex: 35,
                kind: 'file',
                startIndex: 4,
                target: 'src/api/workflows/es-reindex.ts',
                text: 'src/api/workflows/es-reindex.ts',
            },
        ]);
        expect(findTerminalLinks('串联(src/api/workflows/es-reindex.ts)')).toEqual([
            {
                endIndex: 34,
                kind: 'file',
                startIndex: 3,
                target: 'src/api/workflows/es-reindex.ts',
                text: 'src/api/workflows/es-reindex.ts',
            },
        ]);
    });

    it.each(['。', '，', '：'])('splits a path from CJK prose after %s', (separator) => {
        const text = `说明${separator}.local-config/model-config/meta.json:4`;

        expect(findTerminalLinks(text)).toEqual([
            {
                endIndex: text.length,
                kind: 'file',
                location: { mode: 'line', startLine: 4, endLine: 4 },
                startIndex: 3,
                target: '.local-config/model-config/meta.json',
                text: '.local-config/model-config/meta.json:4',
            },
        ]);
    });

    it('rejects ambiguous CJK prose while preserving an explicit relative path', () => {
        expect(findTerminalLinks('说明。workspace/apps/server/src/file.ts:15')).toMatchObject([
            { kind: 'file', target: 'workspace/apps/server/src/file.ts', startIndex: 3 },
        ]);
        expect(findTerminalLinks('账单/配置状态给了陌生人。')).toEqual([]);
        expect(findTerminalLinks('./账单/配置状态 src/Makefile')).toHaveLength(2);
    });

    it('preserves CJK punctuation inside valid relative paths', () => {
        expect(findTerminalLinks('./目录。版本/file.ts:8')).toMatchObject([
            {
                kind: 'file',
                target: './目录。版本/file.ts',
                location: { mode: 'line', startLine: 8, endLine: 8 },
            },
        ]);
        expect(findTerminalLinks('docs/目录。版本/file.ts:8')).toMatchObject([
            {
                kind: 'file',
                target: 'docs/目录。版本/file.ts',
                location: { mode: 'line', startLine: 8, endLine: 8 },
            },
        ]);
        expect(findTerminalLinks('docs/中文说明.md')).toMatchObject([
            { kind: 'file', target: 'docs/中文说明.md' },
        ]);
    });

    it('cuts glued full-width prose after the final path segment', () => {
        // Regression: Claude Code prose such as `path（后者含密钥）。` produced no link at all because the
        // full-width bracket is neither a word separator nor trailing punctuation.
        const glued = '.local-config/example_router_runtime_config.assembled.json（后者含密钥）。';
        expect(findTerminalLinks(`    ${glued}`)).toEqual([
            {
                endIndex: 62,
                kind: 'file',
                startIndex: 4,
                target: '.local-config/example_router_runtime_config.assembled.json',
                text: '.local-config/example_router_runtime_config.assembled.json',
            },
        ]);
        expect(findTerminalLinks('见（src/a.ts）和')).toMatchObject([
            { kind: 'file', target: 'src/a.ts', startIndex: 2, endIndex: 10 },
        ]);
        expect(findTerminalLinks('「docs/b.md」。')).toMatchObject([
            { kind: 'file', target: 'docs/b.md', startIndex: 1, endIndex: 10 },
        ]);
        expect(findTerminalLinks('meta.json。')).toMatchObject([
            { kind: 'file', target: 'meta.json' },
        ]);
        expect(findTerminalLinks('账单/配置状态。', ' ')).toEqual([]);
    });

    it('does not turn a lone slash into a file link', () => {
        expect(findTerminalLinks('aihubmix1 / aihubmix2 带 modelIdMapping。')).toEqual([]);
    });

    it('honors custom word separators from the terminal.wordSeparators setting', () => {
        // Word separators still control fallback tokenization, while the higher-priority local-file
        // parser recognizes an explicit location independently, matching VS Code's detector order.
        expect(findTerminalLinks('串联(src/api/x.ts)', ' ')).toMatchObject([
            { kind: 'file', target: '串联(src/api/x.ts)' },
        ]);
        expect(
            findTerminalLinks('说明。.local-config/model-config/meta.json:4', ' '),
        ).toMatchObject([
            {
                kind: 'file',
                target: '说明。.local-config/model-config/meta.json',
                location: { mode: 'line', startLine: 4, endLine: 4 },
            },
        ]);
        const withColonSeparator = findTerminalLinks('src/a.ts:12', ' :');
        expect(withColonSeparator).toMatchObject([
            {
                kind: 'file',
                target: 'src/a.ts',
                location: { mode: 'line', startLine: 12, endLine: 12 },
            },
        ]);
    });

    it('keeps maximal CJK prose boundary scanning bounded', () => {
        const text = '。'.repeat(16_000);
        const startedAt = performance.now();

        expect(findTerminalLinks(text)).toEqual([]);
        expect(performance.now() - startedAt).toBeLessThan(500);
    });
});
