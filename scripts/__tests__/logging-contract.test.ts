import { glob, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('structured log event call sites', () => {
    it('routes every production write event through the canonical catalog', async () => {
        const bareEvents: string[] = [];
        let scanned = 0;

        // Source lives under each workspace, never at a root-level `src/`; a glob that matches no
        // file makes this gate vacuously green, which is why the count below is asserted too.
        const sourcePaths = glob('{apps,packages,extensions}/*/src/**/*.{ts,tsx}', {
            cwd: repoRoot,
        });
        for await (const path of sourcePaths) {
            if (path.includes('/__tests__/') || /\.(?:e2e|test)\.tsx?$/u.test(path)) continue;
            scanned += 1;
            const source = await readFile(resolve(repoRoot, path), 'utf8');
            const sourceFile = ts.createSourceFile(
                path,
                source,
                ts.ScriptTarget.Latest,
                true,
                path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );
            const visit = (node: ts.Node): void => {
                if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === 'write' &&
                    node.arguments.length >= 2 &&
                    ts.isStringLiteral(node.arguments[1])
                )
                    bareEvents.push(
                        `${path}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
                    );
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }

        expect(scanned).toBeGreaterThan(100);
        expect(bareEvents).toEqual([]);
    });
});
