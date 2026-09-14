import { describe, expect, it } from 'vitest';

import { findRelativeImportSpecifiers } from '../import-links';

function specifiers(source: string): string[] {
    return findRelativeImportSpecifiers(source.split('\n'), 128).map((match) => match.specifier);
}

describe('findRelativeImportSpecifiers', () => {
    it('finds the relative path of every import form that names a file', () => {
        expect(
            specifiers(
                [
                    "import { ErrorClassifier } from '../../errors';",
                    "import './side-effect';",
                    "export * from './barrel';",
                    'const lazy = await import("./lazy");',
                    "const legacy = require('./legacy');",
                ].join('\n'),
            ),
        ).toEqual(['../../errors', './side-effect', './barrel', './lazy', './legacy']);
    });

    it('ignores package names and path aliases, which this feature cannot resolve', () => {
        expect(
            specifiers(
                [
                    "import OpenAI from 'openai';",
                    "import { cn } from '@/lib/utilities';",
                    "import styles from '~/styles.css';",
                ].join('\n'),
            ),
        ).toEqual([]);
    });

    it('covers exactly the text between the quotes so the underline matches the path', () => {
        const [match] = findRelativeImportSpecifiers(["import a from '../b';"], 128);

        expect(match).toEqual({
            endColumn: 20,
            lineNumber: 1,
            specifier: '../b',
            startColumn: 16,
        });
        // Columns are one-based and end-exclusive, so slicing back out of the line returns the specifier itself.
        expect("import a from '../b';".slice(match.startColumn - 1, match.endColumn - 1)).toBe(
            '../b',
        );
    });

    it('reports the line each specifier sits on and stops at the requested limit', () => {
        const matches = findRelativeImportSpecifiers(
            ["import a from './a';", '', "import b from './b';", "import c from './c';"],
            2,
        );

        expect(matches.map((match) => [match.specifier, match.lineNumber])).toEqual([
            ['./a', 1],
            ['./b', 3],
        ]);
    });
});
