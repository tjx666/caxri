import { describe, expect, it } from 'vitest';

import { findTerminalLinks, TERMINAL_DEFAULT_WORD_SEPARATORS } from '../terminal-links';

describe('Terminal reference links', () => {
    const referenceContext = {
        githubRepositories: [{ owner: 'tjx666', repo: 'caxri' }],
        rules: [
            {
                alphanumeric: false,
                ignoreCase: false,
                prefix: 'LOBE-',
                title: 'Linear issue',
                url: 'https://linear.app/lobehub/issue/<num>',
            },
        ],
    };

    const findReferences = (text: string, context = referenceContext) =>
        findTerminalLinks(text, TERMINAL_DEFAULT_WORD_SEPARATORS, undefined, undefined, context);

    it('expands a configured Linear marker without swallowing Chinese punctuation', () => {
        const text = '原有 LOBE-13468 也已补了一条范围说明。';

        expect(findReferences(text)).toMatchObject([
            {
                accessibleName: 'Open Linear issue LOBE-13468',
                detail: 'Linear issue',
                hint: '⌘ click to open Linear issue LOBE-13468',
                kind: 'url',
                target: 'https://linear.app/lobehub/issue/13468',
                text: 'LOBE-13468',
            },
        ]);
    });

    it('resolves explicit, repository-qualified, and bare GitHub references safely', () => {
        expect(findReferences('tjx666/caxri#439 caxri#439 #439')).toMatchObject([
            { kind: 'url', target: 'https://github.com/tjx666/caxri/issues/439' },
            { kind: 'url', target: 'https://github.com/tjx666/caxri/issues/439' },
            { kind: 'url', target: 'https://github.com/tjx666/caxri/issues/439' },
        ]);

        expect(
            findReferences('#439 caxri#439', {
                githubRepositories: [
                    { owner: 'tjx666', repo: 'caxri' },
                    { owner: 'other', repo: 'caxri' },
                ],
                rules: [],
            }),
        ).toEqual([]);
        expect(
            findReferences('tjx666/caxri#439', { githubRepositories: [], rules: [] }),
        ).toMatchObject([{ target: 'https://github.com/tjx666/caxri/issues/439' }]);
    });

    it('detects standalone Git commit candidates without linking common hex lookalikes', () => {
        const shortSha = 'f36a02ac';
        const fullSha = 'f36a02ac8e0aabfd05ebcd218acd32237dc48bb3';

        expect(findReferences(`${shortSha} ${fullSha}`)).toMatchObject([
            { kind: 'commit', target: shortSha, text: shortSha },
            { kind: 'commit', target: fullSha, text: fullSha },
        ]);
        expect(findReferences('abc1234..def5678')).toMatchObject([
            { kind: 'commit', target: 'abc1234' },
            { kind: 'commit', target: 'def5678' },
        ]);
        expect(
            findReferences(
                '#a1b2c3 1234567 1.2.3 550e8400-e29b-41d4-a716-446655440000 src/deadbeef/file.ts https://example.com/deadbeef',
            ).filter(({ kind }) => kind === 'commit'),
        ).toEqual([]);
    });

    it('requires a digit in alphanumeric identifiers and gives configured rules priority', () => {
        expect(
            findReferences('GH-pages GH-123 #439', {
                githubRepositories: [{ owner: 'tjx666', repo: 'caxri' }],
                rules: [
                    {
                        alphanumeric: true,
                        ignoreCase: true,
                        prefix: 'GH-',
                        title: 'Tracker item',
                        url: 'https://tracker.example/items/<num>',
                    },
                    {
                        alphanumeric: false,
                        ignoreCase: false,
                        prefix: '#',
                        title: 'Private tracker item',
                        url: 'https://tracker.example/private/<num>',
                    },
                ],
            }),
        ).toMatchObject([
            { target: 'https://tracker.example/items/123', text: 'GH-123' },
            { target: 'https://tracker.example/private/439', text: '#439' },
        ]);
    });

    it('keeps alphanumeric matching independent from prefix case sensitivity', () => {
        expect(
            findReferences('jira-123 JIRA-ABC1 JIRA-123', {
                githubRepositories: [],
                rules: [
                    {
                        alphanumeric: true,
                        ignoreCase: false,
                        prefix: 'JIRA-',
                        title: 'Jira issue',
                        url: 'https://jira.example/browse/<num>',
                    },
                ],
            }),
        ).toMatchObject([
            { target: 'https://jira.example/browse/ABC1', text: 'JIRA-ABC1' },
            { target: 'https://jira.example/browse/123', text: 'JIRA-123' },
        ]);
    });

    it('does not match configured references inside ASCII words', () => {
        expect(findReferences('XLOBE-123 LOBE-123ABC LOBE-123')).toMatchObject([
            { target: 'https://linear.app/lobehub/issue/123', text: 'LOBE-123' },
        ]);
    });

    it('preserves existing file-link priority over configured references', () => {
        expect(findReferences('src/LOBE-123')).toMatchObject([
            { kind: 'file', target: 'src/LOBE-123', text: 'src/LOBE-123' },
        ]);
    });

    it('bounds configured identifiers before expanding a URL', () => {
        expect(findReferences(`LOBE-${'1'.repeat(1_025)}`)).toEqual([]);
    });
});
