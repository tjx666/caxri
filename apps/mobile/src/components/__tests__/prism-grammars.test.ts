import '../prism-grammars';

import { Prism } from 'prism-react-renderer';
import { describe, expect, it } from 'vitest';

const tokenTypes = (code: string, language: string): string[] =>
    Prism.tokenize(code, Prism.languages[language] ?? {}).flatMap((token) =>
        typeof token === 'string' ? [] : [token.type],
    );

describe('Prism grammars for Agent output', () => {
    it('separates a diff into header, hunk, added, and removed lines', () => {
        expect(
            tokenTypes('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n same', 'diff'),
        ).toEqual(['comment', 'comment', 'constant', 'deleted', 'inserted']);
    });

    it('paints shell strings, variables, keywords, flags, and comments', () => {
        expect(tokenTypes('for f in "$HOME/a b"; do ls --all $f; done # list', 'bash')).toEqual([
            'keyword',
            'keyword',
            'string',
            'keyword',
            'attr-name',
            'variable',
            'keyword',
            'comment',
        ]);
    });
});
