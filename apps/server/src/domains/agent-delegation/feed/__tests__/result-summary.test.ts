import { describe, expect, it } from 'vitest';

import { delegationResultSummary } from '../result-summary';

describe('delegationResultSummary', () => {
    it('reads the closing Summary line the Agent was asked to write', () => {
        const answer = [
            'I read the retry code and traced the backoff.',
            '',
            'Nothing else needs to change.',
            'Summary: The retry backoff is correct; no change needed.',
        ].join('\n');

        expect(delegationResultSummary(answer)).toEqual({
            text: 'The retry backoff is correct; no change needed.',
            source: 'authored',
        });
    });

    it('accepts emphasis around the label, any case, and extra spaces', () => {
        for (const line of [
            '**Summary:** Fixed the race.',
            '**Summary**: Fixed the race.',
            '**Summary** Fixed the race.',
            'summary: Fixed the race.',
            '  SUMMARY:   Fixed   the race. ',
        ])
            expect(delegationResultSummary(`Done.\n${line}`)).toEqual({
                text: 'Fixed the race.',
                source: 'authored',
            });
    });

    it('strips the emphasis that closes the label or wraps the whole text', () => {
        for (const line of [
            '**Summary: Fixed the race.**',
            '__Summary: Fixed the race.__',
            '*Summary: Fixed the race.*',
            '***Summary: Fixed the race.***',
            '*Summary:* Fixed the race.',
            'Summary:** Fixed the race.',
            '**Summary:**Fixed the race.',
            '**Summary:** *Fixed the race.*',
            'Summary: _Fixed the race._',
            'Summary: **Fixed the race.**',
            '_Summary_: Fixed the race.',
        ])
            expect(delegationResultSummary(`Done.\n${line}`), line).toEqual({
                text: 'Fixed the race.',
                source: 'authored',
            });
    });

    it('keeps the markers, colons, and identifiers that belong to the summary itself', () => {
        const cases: Record<string, string> = {
            'Summary: Added tests for __init__': 'Added tests for __init__',
            'Summary: Renamed the helper to __init__': 'Renamed the helper to __init__',
            'Summary: Updated src/**': 'Updated src/**',
            'Summary: Renamed _private_': 'Renamed _private_',
            'Summary: _private fields were made public': '_private fields were made public',
            'Summary: *args handling fixed': '*args handling fixed',
            'Summary:*args handling fixed': '*args handling fixed',
            'Summary: **bold** ending': '**bold** ending',
            'Summary: **bold** and **more**': '**bold** and **more**',
            'Summary: What next?:': 'What next?:',
            'Summary: ran make test (exit: 0):': 'ran make test (exit: 0):',
            'Summary: Fixed the race.:': 'Fixed the race.:',
            '**Summary:** Updated src/**': 'Updated src/**',
            '__Summary: renamed __init__': 'renamed __init__',
            '**Summary: renamed __init__**': 'renamed __init__',
        };
        for (const [line, text] of Object.entries(cases))
            expect(delegationResultSummary(`Done.\n${line}`), line).toEqual({
                text,
                source: 'authored',
            });
    });

    it('keeps the identifiers of a summary on the line after a label that stands alone', () => {
        for (const [next, text] of [
            ['*args handling fixed', '*args handling fixed'],
            ['- Added tests for __init__', 'Added tests for __init__'],
            ['**bold** ending', '**bold** ending'],
        ])
            expect(delegationResultSummary(`Done.\n**Summary:**\n${next}`), next).toEqual({
                text,
                source: 'authored',
            });
    });

    it('takes the next non-empty line for a label that stands alone, without its list marker', () => {
        const nextLines = [
            'Fixed the race.',
            '- Fixed the race.',
            '* Fixed the race.',
            '2. Fixed the race.',
            '**Fixed the race.**',
        ];
        for (const label of ['**Summary:**', '**Summary**:', 'Summary:**', 'Summary:'])
            for (const next of nextLines)
                expect(
                    delegationResultSummary(`Done.\n${label}\n\n${next}`),
                    `${label} then ${next}`,
                ).toEqual({ text: 'Fixed the race.', source: 'authored' });
    });

    it('does not take a label with nothing usable after it for a summary', () => {
        for (const answer of [
            'Result text.\n\n**Summary:**',
            'Result text.\n\n**Summary**:',
            'Result text.\n\nSummary:**',
            'Result text.\n\n**Summary:**\n\n**',
            'Result text.\n\n**Summary:**\n## Next',
            'Result text.\n\n**Summary:**\n```',
        ])
            expect(delegationResultSummary(answer), answer).toEqual({
                text: 'Result text.',
                source: 'excerpt',
            });
    });

    it('keeps an earlier Summary line when the last label has nothing after it', () => {
        expect(delegationResultSummary('Summary: The real one.\n\nSummary:')).toEqual({
            text: 'The real one.',
            source: 'authored',
        });
    });

    it('ignores a label whose next line is outside the final five non-empty lines', () => {
        const answer = ['**Summary:**', 'Fixed the race.', 'a', 'b', 'c', 'd'].join('\n');

        expect(delegationResultSummary(answer)).toEqual({
            text: '**Summary:** Fixed the race. a b c d',
            source: 'excerpt',
        });
    });

    it('does not take an identifier that starts with the word for the label', () => {
        expect(delegationResultSummary('Result text.\n\nSummary_of_changes: none')).toEqual({
            text: 'Result text.',
            source: 'excerpt',
        });
    });

    it('takes the last Summary line among the final five non-empty lines', () => {
        const answer = [
            'Summary: An early draft.',
            'one',
            'Summary: The real one.',
            '',
            'two',
            '',
            'three',
        ].join('\n');

        expect(delegationResultSummary(answer)?.text).toBe('The real one.');
    });

    it('ignores a Summary line that is not near the end and falls back to the first paragraph', () => {
        const answer = ['Summary: Not at the end.', '', 'a', 'b', 'c', 'd', 'e', 'f'].join('\n');

        expect(delegationResultSummary(answer)).toEqual({
            text: 'Summary: Not at the end.',
            source: 'excerpt',
        });
    });

    it('excerpts the first paragraph that is not a heading or a code fence, whitespace collapsed', () => {
        const answer = [
            '# Findings',
            '',
            '```ts',
            'const hidden = true;',
            '',
            'still code',
            '```',
            '',
            'The cache   key ignores the\tlocale,',
            'so two users share one entry.',
            '',
            'Second paragraph.',
        ].join('\n');

        expect(delegationResultSummary(answer)).toEqual({
            text: 'The cache key ignores the locale, so two users share one entry.',
            source: 'excerpt',
        });
    });

    it('clips an authored or excerpted summary to 280 characters with an ellipsis', () => {
        const long = 'word '.repeat(200);

        for (const answer of [`Summary: ${long}`, long]) {
            const summary = delegationResultSummary(answer);
            expect([...summary!.text]).toHaveLength(280);
            expect(summary!.text.endsWith('…')).toBe(true);
        }
    });

    it('has no summary for an answer without text', () => {
        expect(delegationResultSummary('')).toBeUndefined();
        expect(delegationResultSummary('\n  \n')).toBeUndefined();
        expect(delegationResultSummary('# Only a heading\n\n```\ncode\n```')).toBeUndefined();
    });

    it('does not take a line that merely starts with the word for the Summary line', () => {
        expect(delegationResultSummary('Result text.\n\nSummary of changes below')).toEqual({
            text: 'Result text.',
            source: 'excerpt',
        });
    });

    it('does not take an empty Summary label for a summary', () => {
        expect(delegationResultSummary('Result text.\n\nSummary:')).toEqual({
            text: 'Result text.',
            source: 'excerpt',
        });
    });
});
