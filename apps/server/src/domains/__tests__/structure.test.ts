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

/**
 * Flat modules that already sat beside a domain directory their name prefix names (for example the `terminal-*.ts`
 * modules next to `domains/terminal/`) when the flat-placement guard landed. They predate the guard and are not an
 * endorsed shape: this list must only shrink. Moving a module into its domain directory forces its removal here (the
 * stale-entry test fails otherwise), and a new flat module in this shape fails CI instead of joining the list.
 */
const preexistingFlatModulesBesideTheirDomain: readonly string[] = Object.freeze([
    'git-review-comments.ts',
    'git-review-send.ts',
    'terminal-relaunch.ts',
    'terminal-restart.ts',
    'terminal-restore.ts',
    'terminal-surface-switch.ts',
]);

/**
 * Flat modules that already belonged to a same-prefix family of three or more flat modules with no domain directory
 * (for example the `session-*.ts` modules) when the flat-placement guard landed. They predate the guard and are not an
 * endorsed shape: this list must only shrink. Folding a family into its own domain directory forces its removal here
 * (the stale-entry test fails otherwise), and a new member of any family, listed or not, fails CI. Every such family
 * has since moved into a domain directory, so the list is empty and must stay that way.
 */
const preexistingFlatFamilyModules: readonly string[] = Object.freeze([]);

/**
 * A flat `domains/*.ts` module that the packages.md scale rule places inside `domains/<domain>/`.
 */
interface MisplacedFlatModule {
    /**
     * File name directly under `domains/`, for example `terminal-input.ts`.
     */
    readonly module: string;
    /**
     * Domain directory the module belongs in, for example `terminal`.
     */
    readonly domain: string;
}

function moduleStem(fileName: string): string {
    return fileName.slice(0, -'.ts'.length);
}

/**
 * The longest domain directory name that prefixes `stem` on a hyphen boundary. Matching the full directory name, not
 * the first segment, lets `project-status/` claim `project-status-*.ts` without also claiming `project-roots.ts`, and
 * keeps `agent-chat/` from claiming `agent-runtime.ts`.
 */
function claimingDomainDirectory(
    stem: string,
    domainDirectories: readonly string[],
): string | undefined {
    let claimant: string | undefined;
    for (const directory of domainDirectories) {
        const claims = stem === directory || stem.startsWith(`${directory}-`);
        if (claims && directory.length > (claimant?.length ?? 0)) claimant = directory;
    }
    return claimant;
}

/**
 * The longest hyphen-segment prefix every stem shares; family members always share at least their first segment.
 */
function sharedSegmentPrefix(stems: readonly string[]): string {
    const [first, ...rest] = stems.map((stem) => stem.split('-'));
    let length = 0;
    while (length < first.length && rest.every((segments) => segments[length] === first[length]))
        length += 1;
    return first.slice(0, length).join('-');
}

/**
 * Code-unit order, matching how the allowlists are written, independent of the host locale.
 */
function compareCodeUnits(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function byModuleName(left: MisplacedFlatModule, right: MisplacedFlatModule): number {
    return compareCodeUnits(left.module, right.module);
}

/**
 * Flat modules whose hyphen prefix (or whole stem) already names a domain directory, which must own them.
 */
function findFlatModulesBesideTheirDomain(
    flatModules: readonly string[],
    domainDirectories: readonly string[],
): MisplacedFlatModule[] {
    return flatModules
        .flatMap((module) => {
            const domain = claimingDomainDirectory(moduleStem(module), domainDirectories);
            return domain === undefined ? [] : [{ module, domain }];
        })
        .toSorted(byModuleName);
}

/**
 * Flat modules in a family of three or more that shares a first hyphen-separated segment and has no domain directory
 * yet. Grouping uses the first segment because any longer shared prefix only selects a subset of that family, so it
 * could only miss clusters (`session-context`, `session-pull-requests`, and `session-rename` share nothing longer than
 * `session`). The suggested directory is the longest prefix the whole family shares, so a `pull-request-*` family
 * points at `domains/pull-request/` rather than `domains/pull/`. Modules already claimed by a domain directory are
 * reported only by {@link findFlatModulesBesideTheirDomain}, keeping the two checks and their allowlists disjoint.
 */
function findFlatFamiliesOfThreeOrMore(
    flatModules: readonly string[],
    domainDirectories: readonly string[],
): MisplacedFlatModule[] {
    const families = new Map<string, string[]>();
    for (const module of flatModules) {
        const stem = moduleStem(module);
        if (claimingDomainDirectory(stem, domainDirectories) !== undefined) continue;
        const key = stem.split('-', 1)[0];
        families.set(key, [...(families.get(key) ?? []), module]);
    }
    return families
        .values()
        .filter((members) => members.length >= 3)
        .flatMap((members) => {
            const domain = sharedSegmentPrefix(members.map(moduleStem));
            return members.map((module) => ({ module, domain }));
        })
        .toArray()
        .toSorted(byModuleName);
}

function unlistedPlacements(
    misplaced: readonly MisplacedFlatModule[],
    allowlist: readonly string[],
): string[] {
    return misplaced
        .filter(({ module }) => !allowlist.includes(module))
        .map(({ module, domain }) => `${module} -> domains/${domain}/`);
}

async function listDomainsRoot(): Promise<{
    flatModules: string[];
    domainDirectories: string[];
}> {
    const rootEntries = await readdir(domainsRoot, { withFileTypes: true });
    return {
        flatModules: rootEntries
            .filter((entry) => entry.isFile() && isProductionTypeScript(entry.name))
            .map((entry) => entry.name),
        domainDirectories: rootEntries
            .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
            .map((entry) => entry.name),
    };
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

    it('rejects a flat module whose name prefix already names a domain directory', async () => {
        const { flatModules, domainDirectories } = await listDomainsRoot();
        const offenders = unlistedPlacements(
            findFlatModulesBesideTheirDomain(flatModules, domainDirectories),
            preexistingFlatModulesBesideTheirDomain,
        );

        expect(
            offenders,
            'place each module in the listed domains/<prefix>/ directory and export it through that index.ts ' +
                '(project-architecture packages.md scale rule); do not extend the pre-existing allowlist',
        ).toEqual([]);
    });

    it('rejects a flat module in a same-prefix family of three or more modules', async () => {
        const { flatModules, domainDirectories } = await listDomainsRoot();
        const offenders = unlistedPlacements(
            findFlatFamiliesOfThreeOrMore(flatModules, domainDirectories),
            preexistingFlatFamilyModules,
        );

        expect(
            offenders,
            'three or more cohesive modules own domains/<prefix>/ with an index.ts barrel ' +
                '(project-architecture packages.md scale rule); move the family there instead of extending the ' +
                'pre-existing allowlist',
        ).toEqual([]);
    });

    it('keeps the pre-existing flat-placement allowlists sorted and limited to current offenders', async () => {
        const { flatModules, domainDirectories } = await listDomainsRoot();
        const allowlists = [
            {
                entries: preexistingFlatModulesBesideTheirDomain,
                offenders: findFlatModulesBesideTheirDomain(flatModules, domainDirectories),
            },
            {
                entries: preexistingFlatFamilyModules,
                offenders: findFlatFamiliesOfThreeOrMore(flatModules, domainDirectories),
            },
        ];

        for (const { entries, offenders } of allowlists) {
            expect(entries, 'allowlists stay sorted and unique').toEqual(
                [...new Set(entries)].toSorted(compareCodeUnits),
            );
            const current = new Set(offenders.map(({ module }) => module));
            expect(
                entries.filter((entry) => !current.has(entry)),
                'allowlisted modules that moved, were deleted, or no longer violate the rule must leave the allowlist',
            ).toEqual([]);
        }
    });

    it('reports new flat-placement violations from a synthetic domains listing', () => {
        const domainDirectories = ['agent-chat', 'agents', 'project-status', 'terminal'];
        const flatModules = [
            'agent-chat-extra.ts',
            'agent-runtime.ts',
            'diagnostics.ts',
            'project-roots.ts',
            'pull-request-merge-notice.ts',
            'pull-request-merge-refresh.ts',
            'pull-request-review.ts',
            'session-context.ts',
            'session-creation.ts',
            'terminal.ts',
            'terminal-input.ts',
            'workbench-roots.ts',
            'workbench-snapshot.ts',
        ];

        expect(findFlatModulesBesideTheirDomain(flatModules, domainDirectories)).toEqual([
            { module: 'agent-chat-extra.ts', domain: 'agent-chat' },
            { module: 'terminal-input.ts', domain: 'terminal' },
            { module: 'terminal.ts', domain: 'terminal' },
        ]);
        expect(findFlatFamiliesOfThreeOrMore(flatModules, domainDirectories)).toEqual([
            { module: 'pull-request-merge-notice.ts', domain: 'pull-request' },
            { module: 'pull-request-merge-refresh.ts', domain: 'pull-request' },
            { module: 'pull-request-review.ts', domain: 'pull-request' },
        ]);
        expect(
            unlistedPlacements(
                findFlatFamiliesOfThreeOrMore(
                    [...flatModules, 'session-rename.ts'],
                    domainDirectories,
                ),
                ['session-context.ts', 'session-creation.ts'],
            ),
        ).toEqual([
            'pull-request-merge-notice.ts -> domains/pull-request/',
            'pull-request-merge-refresh.ts -> domains/pull-request/',
            'pull-request-review.ts -> domains/pull-request/',
            'session-rename.ts -> domains/session/',
        ]);
    });
});
