import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { execFileAsync } from '../exec';

interface ActionStep {
    env?: Record<string, string>;
    id?: string;
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, string>;
}

interface ActionDocument {
    runs: { steps: ActionStep[] };
}

interface PackageManifest {
    devDependencies: Record<string, string>;
    scripts?: Record<string, string>;
}

const mise = await readFile(new URL('../../mise.toml', import.meta.url), 'utf8');
const setupAction = await readFile(
    new URL('../../.github/actions/setup-caxri-job/action.yml', import.meta.url),
    'utf8',
);
const setupActionDocument = parse(setupAction) as ActionDocument;
const packageManifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageManifest;
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/**
 * The `tsc` the mobile `typecheck` script runs: the root TypeScript 7 CLI, addressed by path because the workspace's
 * own TypeScript 6 `tsc` bin shadows it on `PATH`. See the `apps/mobile` exception in
 * `.agents/skills/project-architecture/references/stack-baseline.md`.
 */
const mobileTypecheckTscPath = join(repoRoot, 'node_modules/.bin/tsc');
const mobileTypecheckTsc = '../../node_modules/.bin/tsc';

function miseVersion(tool: 'node' | 'pnpm'): string {
    const match = mise.match(new RegExp(`^${tool} = "([^"]+)"$`, 'mu'));

    if (!match?.[1]) throw new Error(`mise.toml does not define an exact ${tool} version`);
    return match[1];
}

function stepByName(name: string): ActionStep {
    const step = setupActionDocument.runs.steps.find((candidate) => candidate.name === name);

    if (!step) throw new Error(`Missing setup action step: ${name}`);
    return step;
}

function literalVersionLocations(): string[] {
    const versions = [miseVersion('node'), miseVersion('pnpm')];

    return setupAction
        .split('\n')
        .flatMap((line, index) =>
            versions.some((version) => line.includes(version))
                ? `.github/actions/setup-caxri-job/action.yml:${index + 1}`
                : [],
        );
}

async function repoVersionLocations(): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: repoRoot });
    const executableSource =
        /(?:^|\/)(?:[^/]+\.(?:cjs|js|json|mjs|sh|toml|ts|yaml|yml)|Dockerfile)$/u;
    /**
     * The footprint baseline is a measured artifact receipt, not a toolchain configuration source. Its archive names
     * deliberately preserve the runtime version that produced each measurement.
     */
    const excluded = new Set([
        'mise.toml',
        'pnpm-lock.yaml',
        'scripts/server-footprint-baseline.json',
    ]);
    const versions = [miseVersion('node'), miseVersion('pnpm')];

    const candidates = stdout
        .split('\0')
        .filter((path) => path && !excluded.has(path) && executableSource.test(path));
    const sources = (
        await Promise.all(
            candidates.map(async (path) => {
                try {
                    return { path, source: await readFile(join(repoRoot, path), 'utf8') };
                } catch (error) {
                    /**
                     * `git ls-files` includes tracked paths deleted by an in-progress refactor. They are not version
                     * sources in the working tree and must not make this dirty-worktree-safe contract fail early.
                     */
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                    throw error;
                }
            }),
        )
    ).filter((candidate) => candidate !== undefined);

    return sources.flatMap(({ path, source }) =>
        versions.some((version) => versionSearchText(path, source).includes(version)) ? [path] : [],
    );
}

/**
 * The part of a file that could be pinning the toolchain.
 *
 * A `package.json` dependency range is not a Node.js or pnpm version copy even when the two strings collide, which
 * really happens: an ordinary library can reach the same major.minor.patch as the pinned pnpm. Everything else in the
 * manifest (`engines`, `volta`, a script, `packageManager`) is exactly what this contract exists to catch, so only the
 * dependency maps are removed rather than the whole file.
 */
function versionSearchText(path: string, source: string): string {
    if (!path.endsWith('package.json')) return source;
    try {
        const manifest = JSON.parse(source) as Record<string, unknown>;
        for (const field of [
            'dependencies',
            'devDependencies',
            'optionalDependencies',
            'peerDependencies',
        ])
            delete manifest[field];
        return JSON.stringify(manifest);
    } catch {
        return source;
    }
}

describe('toolchain contract', () => {
    it('exempts only exact, still-resolved versions from the release-age floor', async () => {
        const workspace = parse(
            await readFile(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8'),
        ) as { minimumReleaseAgeExclude: string[] };
        const lockfile = await readFile(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
        const resolved = new Set(
            lockfile.matchAll(/^ {2}'?(@?[^@\s'(]+@[^\s'(:]+)'?:/gmu).map((match) => match[1]),
        );
        // An unversioned entry exempts every future release; a version the lockfile no longer resolves exempts nothing
        // and only hides which exemptions still matter.
        const stale = workspace.minimumReleaseAgeExclude.filter(
            (entry) => !/^@?[^@]+@\d/u.test(entry) || !resolved.has(entry),
        );
        expect(stale).toEqual([]);
    });

    it('places the standalone pnpm tool ahead of Node Corepack shims', () => {
        expect(mise.search(/^pnpm = /mu)).toBeLessThan(mise.search(/^node = /mu));
    });

    it('loads the exact Node.js and pnpm versions from mise.toml without action-local copies', async () => {
        const versionStep = stepByName('Read mise tool versions');
        const nodeSetupStep = setupActionDocument.runs.steps.find((step) =>
            step.uses?.startsWith('actions/setup-node@'),
        );
        const pnpmSetupStep = setupActionDocument.runs.steps.find((step) =>
            step.uses?.startsWith('pnpm/setup@'),
        );
        const verifyStep = stepByName('Verify exact Node.js and pnpm');

        expect(versionStep.id).toBe('tool_versions');
        expect(versionStep.run).toContain('mise.toml');
        expect(versionStep.run).toContain('echo "node=$node_version" >> "$GITHUB_OUTPUT"');
        expect(versionStep.run).toContain('echo "pnpm=$pnpm_version" >> "$GITHUB_OUTPUT"');
        expect(nodeSetupStep?.with?.['node-version']).toBe(
            '${{ steps.tool_versions.outputs.node }}',
        );
        expect(pnpmSetupStep?.with?.version).toBe('${{ steps.tool_versions.outputs.pnpm }}');
        expect(pnpmSetupStep?.with?.dest).toBe('${{ runner.temp }}/caxri-pnpm');
        expect(setupAction).not.toContain('runner.tool_cache');
        expect(setupAction).not.toContain('Reuse runner-cached pnpm');
        const versionEnvironment = {
            CAXRI_NODE_VERSION: '${{ steps.tool_versions.outputs.node }}',
            CAXRI_PNPM_VERSION: '${{ steps.tool_versions.outputs.pnpm }}',
        };
        expect(verifyStep.env).toEqual(versionEnvironment);
        expect(verifyStep.run).toContain('"v$CAXRI_NODE_VERSION"');
        expect(verifyStep.run).toContain('"$CAXRI_PNPM_VERSION"');

        const literalLocations = literalVersionLocations();
        expect(
            literalLocations,
            `Action-local version copies: ${literalLocations.join(', ')}`,
        ).toEqual([]);
        const repoLocations = await repoVersionLocations();
        expect(
            repoLocations,
            `Repository-local version copies: ${repoLocations.join(', ')}`,
        ).toEqual([]);
    });

    it('exports the mise versions for later composite-action steps', async () => {
        const versionStep = stepByName('Read mise tool versions');
        const workspace = await mkdtemp(join(tmpdir(), 'caxri-toolchain-contract-'));
        const githubOutput = join(workspace, 'github-output');

        try {
            await writeFile(join(workspace, 'mise.toml'), mise);
            await writeFile(githubOutput, '');
            await execFileAsync(
                'bash',
                ['-e', '-o', 'pipefail', '-c', versionStep.run ?? 'exit 1'],
                {
                    cwd: workspace,
                    env: { ...process.env, GITHUB_OUTPUT: githubOutput },
                },
            );

            expect((await readFile(githubOutput, 'utf8')).trim().split('\n')).toEqual([
                `node=${miseVersion('node')}`,
                `pnpm=${miseVersion('pnpm')}`,
            ]);
        } finally {
            await rm(workspace, { force: true, recursive: true });
        }
    });

    it('declares the same @types/node major as the Node.js runtime in mise.toml', async () => {
        const majorOf = (version: string): number => Number(/\d+/u.exec(version)?.[0]);
        const runtimeMajor = majorOf(miseVersion('node'));
        const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', '**package.json'], {
            cwd: repoRoot,
        });
        const manifests = stdout.split('\0').filter(Boolean);
        const declared = (
            await Promise.all(
                manifests.map(async (path) => {
                    const manifest = JSON.parse(await readFile(join(repoRoot, path), 'utf8')) as {
                        dependencies?: Record<string, string>;
                        devDependencies?: Record<string, string>;
                    };
                    const range =
                        manifest.devDependencies?.['@types/node'] ??
                        manifest.dependencies?.['@types/node'];

                    return range ? [{ major: majorOf(range), path }] : [];
                }),
            )
        ).flat();

        expect(declared.length).toBeGreaterThan(0);
        expect(declared.filter(({ major }) => major !== runtimeMajor)).toEqual([]);

        const installed = JSON.parse(
            await readFile(join(repoRoot, 'node_modules/@types/node/package.json'), 'utf8'),
        ) as { version: string };

        expect(majorOf(installed.version)).toBe(runtimeMajor);
    });

    it('rejects a builtin newer than the shipped Node.js runtime at typecheck', async () => {
        // `node:vfs` exists only in newer Node.js releases; Node 24 throws ERR_UNKNOWN_BUILTIN_MODULE at runtime.
        // Declarations from a newer major would let this import typecheck silently.
        const directory = await mkdtemp(join(tmpdir(), 'caxri-node-types-'));

        try {
            await writeFile(join(directory, 'probe.ts'), "import 'node:vfs';\n");
            await writeFile(
                join(directory, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        module: 'esnext',
                        moduleResolution: 'bundler',
                        noEmit: true,
                        target: 'es2022',
                        typeRoots: [join(repoRoot, 'node_modules/@types')],
                        types: ['node'],
                    },
                    files: ['probe.ts'],
                }),
            );

            let stdout = '';

            try {
                await execFileAsync(join(repoRoot, 'node_modules', '.bin', 'tsc'), [
                    '-p',
                    join(directory, 'tsconfig.json'),
                ]);
            } catch (error) {
                stdout = (error as { stdout?: string }).stdout ?? '';
            }

            expect(stdout).toContain('node:vfs');
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('keeps the TypeScript 7 CLI and TypeScript 6 JavaScript API wired side by side', async () => {
        const tscPath = join(repoRoot, 'node_modules', '.bin', 'tsc');
        const { stdout } = await execFileAsync(tscPath, ['--version']);
        const eslintConfigRequire = createRequire(
            new URL('../../eslint.config.ts', import.meta.url),
        );
        const eslintConfigEntry = eslintConfigRequire.resolve(
            '@yutengjing/eslint-config-typescript',
        );
        const typescript = createRequire(eslintConfigEntry)('typescript') as { version: string };

        expect(packageManifest.devDependencies['@typescript/native']).toMatch(
            /^npm:typescript@7\./u,
        );
        expect(packageManifest.devDependencies.typescript).toMatch(
            /^npm:@typescript\/typescript6@6\./u,
        );
        expect(stdout.trim()).toMatch(/^Version 7\./u);
        expect(typescript.version).toMatch(/^6\./u);
    });

    it('keeps the TypeScript 6 API Expo tooling needs while apps/mobile typechecks with TypeScript 7', async () => {
        const mobileManifest = JSON.parse(
            await readFile(new URL('../../apps/mobile/package.json', import.meta.url), 'utf8'),
        ) as PackageManifest;
        const mobileRequire = createRequire(join(repoRoot, 'apps/mobile/package.json'));
        const resolvedTypescript = mobileRequire('typescript/package.json') as {
            name: string;
            version: string;
        };
        const { stdout } = await execFileAsync(mobileTypecheckTscPath, ['--version']);
        const typecheck = mobileManifest.scripts?.typecheck ?? '';
        const compilers = typecheck.match(/(?:^|&& )(\S+) --noEmit/gu) ?? [];

        expect(mobileManifest.devDependencies.typescript).toMatch(/^\^6\./u);
        expect(resolvedTypescript).toMatchObject({ name: 'typescript' });
        expect(resolvedTypescript.version).toMatch(/^6\./u);
        expect(compilers).toHaveLength(2);
        for (const compiler of compilers)
            expect(compiler).toContain(`${mobileTypecheckTsc} --noEmit`);
        expect(stdout.trim()).toMatch(/^Version 7\./u);
    });

    it('rejects browser document globals from the React Native runtime project', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'caxri-mobile-runtime-contract-'));
        try {
            await writeFile(
                join(workspace, 'tsconfig.json'),
                JSON.stringify({
                    extends: join(repoRoot, 'apps/mobile/tsconfig.runtime.json'),
                    files: ['./browser-globals.ts'],
                    include: [],
                }),
            );
            await writeFile(
                join(workspace, 'browser-globals.ts'),
                [
                    'document.body;',
                    'window.location;',
                    "localStorage.setItem('key', 'value');",
                    "alert('unsupported');",
                    "void navigator.clipboard.writeText('unsupported');",
                ].join('\n'),
            );

            let diagnostics = '';
            try {
                await execFileAsync(mobileTypecheckTscPath, [
                    '--noEmit',
                    '-p',
                    join(workspace, 'tsconfig.json'),
                ]);
            } catch (error) {
                const failure = error as { stderr?: string; stdout?: string };
                diagnostics = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
            }

            expect(diagnostics).toContain("Cannot find name 'document'");
            expect(diagnostics).toContain("Cannot find name 'window'");
            expect(diagnostics).toContain("Cannot find name 'localStorage'");
            expect(diagnostics).toContain("Cannot find name 'alert'");
            expect(diagnostics).toContain("Property 'clipboard' does not exist");
        } finally {
            await rm(workspace, { force: true, recursive: true });
        }
    });
});
