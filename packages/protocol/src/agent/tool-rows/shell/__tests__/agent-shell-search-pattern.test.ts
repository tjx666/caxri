import { describe, expect, it } from 'vitest';

import { searchPatternTerms } from '../agent-shell-search-pattern.js';

describe('searchPatternTerms', () => {
    it('splits basic grep alternation and drops literal escapes', () => {
        expect(searchPatternTerms(String.raw`退回原批次\|新开批次\|APPROVAL_DEV`, 'basic')).toEqual(
            ['退回原批次', '新开批次', 'APPROVAL_DEV'],
        );
        expect(searchPatternTerms(String.raw`app\.ts`, 'basic')).toEqual(['app.ts']);
        // A bare `|` is a literal in basic syntax.
        expect(searchPatternTerms('a|b', 'basic')).toEqual(['a|b']);
    });

    it('splits extended alternation at the top level only', () => {
        expect(searchPatternTerms('useState|useEffect', 'extended')).toEqual([
            'useState',
            'useEffect',
        ]);
        expect(searchPatternTerms('use(State|Effect)|[a|b]', 'extended')).toEqual([
            'use(State|Effect)',
            '[a|b]',
        ]);
        expect(searchPatternTerms(String.raw`foo\|bar`, 'extended')).toEqual(['foo|bar']);
    });

    it('keeps meaningful escapes, fixed strings, and empty alternatives as written', () => {
        expect(searchPatternTerms(String.raw`\bfoo\b`, 'extended')).toEqual([String.raw`\bfoo\b`]);
        expect(searchPatternTerms(String.raw`a\|b`, 'fixed')).toEqual([String.raw`a\|b`]);
        expect(searchPatternTerms('foo|', 'extended')).toEqual(['foo']);
        expect(searchPatternTerms('|', 'extended')).toEqual(['|']);
    });
});
