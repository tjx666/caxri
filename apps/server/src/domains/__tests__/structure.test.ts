import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const domainsRoot = fileURLToPath(new URL('..', import.meta.url));

function isProductionTypeScript(path: string): boolean {
    return (
        !path.endsWith('.d.ts') &&
        path.endsWith('.ts') &&
        !path.endsWith('.test.ts') &&
        !path.endsWith('.spec.ts') &&
        !path.split(sep).includes('__tests__')
    );
}

async function listProductionModules(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const modules: string[][] = await Promise.all(
        entries.map(async (entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return listProductionModules(path);
            if (entry.isFile() && isProductionTypeScript(path)) return [path];
            return [];
        }),
    );
    return modules.flat();
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

function findCrossDomainImports(
    importer: string,
    source: string,
    directDomains: Set<string>,
): string[] {
    const importerRelative = relative(domainsRoot, importer);
    const importerDomain = importerRelative.split(sep)[0];
    const violations: string[] = [];
    for (const specifier of importSpecifiers(importer, source)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(importer), specifier.split('?', 1)[0]);
        const targetRelative = relative(domainsRoot, target);
        if (targetRelative === '' || targetRelative.startsWith('..')) continue;
        const targetDomain = targetRelative.split(sep)[0];
        if (targetDomain === importerDomain || !directDomains.has(targetDomain)) continue;
        if (target !== join(domainsRoot, targetDomain))
            violations.push(`${importerRelative} -> ${specifier}`);
    }
    return violations;
}

describe('Runtime domain structure', () => {
    it('requires a public barrel for every direct domain with at least three modules', async () => {
        const rootEntries = await readdir(domainsRoot, { withFileTypes: true });
        const directDomains = rootEntries.filter(
            (entry) => entry.isDirectory() && entry.name !== '__tests__',
        );
        const missing = (
            await Promise.all(
                directDomains.map(async (domain) => {
                    const root = join(domainsRoot, domain.name);
                    const modules = await listProductionModules(root);
                    return modules.length >= 3 && !modules.includes(join(root, 'index.ts'))
                        ? domain.name
                        : undefined;
                }),
            )
        ).filter((name): name is string => name !== undefined);

        expect(missing, 'large Runtime domains missing index.ts').toEqual([]);
    });

    it('rejects production imports that reach into another Runtime domain', async () => {
        const rootEntries = await readdir(domainsRoot, { withFileTypes: true });
        const directDomains = new Set(
            rootEntries
                .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
                .map((entry) => entry.name),
        );
        const importers = await listProductionModules(domainsRoot);
        const violations = (
            await Promise.all(
                importers.map(async (importer) =>
                    findCrossDomainImports(
                        importer,
                        await readFile(importer, 'utf8'),
                        directDomains,
                    ),
                ),
            )
        ).flat();

        expect(violations, 'cross-domain imports must target the domain root').toEqual([]);
    });
});
