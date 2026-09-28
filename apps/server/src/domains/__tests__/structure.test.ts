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
        if (target === join(domainsRoot, targetDomain)) continue;
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

    it('keeps external-status independent of project-status, including through the barrel', async () => {
        /**
         * `project-status` reads external-status's barrel to build `ProjectStatusService`, so the reverse import would
         * close a real circular dependency. Unlike the general cross-domain guard above, this direction is banned even
         * at the domain root: `external-status` resolves `linear`, `lh acceptance`, and `gh` on demand for whichever
         * domain asks, and must stay usable without ever knowing `project-status` exists.
         */
        const externalStatusRoot = join(domainsRoot, 'external-status');
        const importers = await listProductionModules(externalStatusRoot);
        const violations = (
            await Promise.all(
                importers.map(async (importer) => {
                    const source = await readFile(importer, 'utf8');
                    return importSpecifiers(importer, source)
                        .filter((specifier) => specifier.includes('project-status'))
                        .map((specifier) => `${relative(domainsRoot, importer)} -> ${specifier}`);
                }),
            )
        ).flat();

        expect(violations, 'external-status must never import project-status').toEqual([]);
    });

    it('rejects a third flat module that shares another flat module as a name prefix', async () => {
        /**
         * `source-layout` scales a cohesive cluster into its own directory once it reaches three modules. A flat
         * `foo.ts` base file next to two or more `foo-*.ts` siblings directly under `domains/` is exactly that cluster
         * still sitting flat (this is how `project-status.ts` plus its twelve `project-status-*.ts` siblings, and later
         * `theme.ts` plus `theme-colors.ts` and `theme-import-source.ts`, looked before each family moved into its own
         * `domains/` directory). Families that predate this guard and have not been folded into a directory yet are
         * listed here explicitly so a _fourth_ file in the same family still fails instead of silently growing.
         */
        const allowedFlatFamilies = new Set<string>();
        const rootEntries = await readdir(domainsRoot, { withFileTypes: true });
        const flatModuleStems = rootEntries
            .filter((entry) => entry.isFile() && isProductionTypeScript(entry.name))
            .map((entry) => entry.name.slice(0, -'.ts'.length));
        const offenders = flatModuleStems.filter((stem) => {
            if (allowedFlatFamilies.has(stem)) return false;
            const siblingCount = flatModuleStems.filter(
                (other) => other !== stem && other.startsWith(`${stem}-`),
            ).length;
            return siblingCount >= 2;
        });

        expect(
            offenders,
            'a base module plus two or more same-prefix siblings belongs in its own domain directory',
        ).toEqual([]);
    });
});
