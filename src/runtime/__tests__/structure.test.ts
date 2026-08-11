import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const runtimeRoot = fileURLToPath(new URL('..', import.meta.url));

function isProductionTypeScript(path: string): boolean {
    return (
        path.endsWith('.ts') &&
        !path.endsWith('.d.ts') &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.spec.ts') &&
        !path.split(sep).includes('__tests__')
    );
}

async function listProductionModules(directory: string): Promise<string[]> {
    const modules: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) modules.push(...(await listProductionModules(path)));
        else if (entry.isFile() && isProductionTypeScript(path)) modules.push(path);
    }
    return modules;
}

function importSpecifiers(path: string, source: string): string[] {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            specifiers.push(node.moduleSpecifier.text);
        } else if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            specifiers.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return specifiers;
}

describe('Runtime domain structure', () => {
    it('requires a public barrel for every direct domain with at least three modules', async () => {
        const directDomains = (await readdir(runtimeRoot, { withFileTypes: true })).filter(
            (entry) => entry.isDirectory() && entry.name !== '__tests__',
        );
        const missing: string[] = [];
        for (const domain of directDomains) {
            const root = join(runtimeRoot, domain.name);
            const modules = await listProductionModules(root);
            if (modules.length >= 3 && !modules.includes(join(root, 'index.ts')))
                missing.push(domain.name);
        }

        expect(missing, 'large Runtime domains missing index.ts').toEqual([]);
    });

    it('rejects production imports that reach into another Runtime domain', async () => {
        const directDomains = new Set(
            (await readdir(runtimeRoot, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
                .map((entry) => entry.name),
        );
        const violations: string[] = [];
        for (const importer of await listProductionModules(runtimeRoot)) {
            const importerRelative = relative(runtimeRoot, importer);
            const importerDomain = importerRelative.split(sep)[0];
            for (const specifier of importSpecifiers(importer, await readFile(importer, 'utf8'))) {
                if (!specifier.startsWith('.')) continue;
                const target = resolve(dirname(importer), specifier.split('?')[0]);
                const targetRelative = relative(runtimeRoot, target);
                if (targetRelative.startsWith('..') || targetRelative === '') continue;
                const targetDomain = targetRelative.split(sep)[0];
                if (!directDomains.has(targetDomain) || targetDomain === importerDomain) continue;
                if (target !== join(runtimeRoot, targetDomain))
                    violations.push(`${importerRelative} -> ${specifier}`);
            }
        }

        expect(violations, 'cross-domain imports must target the domain root').toEqual([]);
    });
});
