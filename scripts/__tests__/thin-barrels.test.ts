import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

/**
 * `index.ts` files that must stay thin public barrels (see the `source-layout` skill): every top-level statement is a
 * re-export from a named module, so implementation never accumulates in an entry point that neighbours copy. Add a
 * barrel here when its implementation moves out; do not exempt one by removing it.
 */
const THIN_BARREL_INDEXES = [
    'apps/server/src/domains/git/index.ts',
    'apps/server/src/domains/config/index.ts',
    'apps/server/src/domains/project-status/index.ts',
    'apps/server/src/domains/theme/index.ts',
    'apps/server/src/domains/agents/providers/claude/index.ts',
    'apps/server/src/domains/agents/providers/codex/index.ts',
    'packages/extension-api/src/index.ts',
] as const;

/**
 * Describes each top-level statement that is not `export ... from '<module>'`.
 */
function findNonReExportStatements(path: string, source: string): string[] {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    return sourceFile.statements
        .filter(
            (statement) =>
                !ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined,
        )
        .map((statement) => {
            const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart());
            return `${path}:${line + 1} ${statement.getText().split('\n', 1)[0]}`;
        });
}

describe('thin barrel index files', () => {
    it('detects implementation and local exports in a barrel', () => {
        const source = [
            "import { a } from './a';",
            "export { b } from './b';",
            'export const c = 1;',
            'export { a };',
            'function d() {}',
        ].join('\n');
        expect(findNonReExportStatements('x.ts', source)).toEqual([
            "x.ts:1 import { a } from './a';",
            'x.ts:3 export const c = 1;',
            'x.ts:4 export { a };',
            'x.ts:5 function d() {}',
        ]);
    });

    it.each(THIN_BARREL_INDEXES)('%s contains only re-exports', async (relativePath) => {
        const source = await readFile(join(workspaceRoot, relativePath), 'utf8');
        expect(findNonReExportStatements(relativePath, source)).toEqual([]);
    });
});
