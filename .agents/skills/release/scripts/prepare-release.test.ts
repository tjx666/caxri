import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GitReader } from './prepare-release';
import {
    assertMainCiHealthy,
    assertReleaseSource,
    prepareRelease,
    runPrepareRelease,
} from './prepare-release';
import type { ReleaseSourceReader } from './release-sources';
import {
    discoverReleaseSourcePaths,
    isExactReleasePreparationDelta,
    isStrictlyNewerVersion,
} from './release-sources';

const temporaryDirectories: string[] = [];
const manifests = [
    'package.json',
    'apps/cli/package.json',
    'apps/desktop/package.json',
    'apps/mobile/package.json',
    'apps/server/package.json',
    'packages/agent-skills/package.json',
    'packages/client/package.json',
    'packages/extension-api/package.json',
    'extensions/fixture/package.json',
    'extensions/git/package.json',
    'extensions/status/package.json',
];
const extensions = new Set([
    'extensions/fixture/package.json',
    'extensions/git/package.json',
    'extensions/status/package.json',
]);

async function fixture(overrides: Record<string, string> = {}): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), 'caxri-prepare-release-'));
    temporaryDirectories.push(cwd);
    const sources: Record<string, string> = {
        'apps/cli/src/version.ts': "export const CLI_VERSION = '0.0.24';\n",
        'packages/agent-skills/src/version.ts': "export const SKILL_BUNDLE_VERSION = '0.0.24';\n",
    };
    for (const path of manifests) {
        sources[path] = `${JSON.stringify(
            {
                name: path,
                version: '0.0.24',
                ...(extensions.has(path) && { engines: { caxri: '^0.0.24' } }),
            },
            undefined,
            4,
        )}\n`;
    }

    await Promise.all(
        Object.entries({ ...sources, ...overrides }).map(async ([path, source]) => {
            const absolutePath = join(cwd, path);
            await mkdir(dirname(absolutePath), { recursive: true });
            await writeFile(absolutePath, source, 'utf8');
        }),
    );
    return cwd;
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

function cleanReleaseGit(overrides: Record<string, string> = {}): GitReader {
    return async (arguments_) => {
        const key = arguments_.join(' ');
        return (
            overrides[key] ??
            {
                'rev-parse HEAD': 'release-head',
                'rev-parse refs/remotes/origin/main': 'release-head',
                'status --porcelain --untracked-files=all': '',
            }[key] ??
            ''
        );
    };
}

const greenMainCi = async () =>
    JSON.stringify([{ conclusion: 'success', displayTitle: 'fix: x', headSha: 'a'.repeat(40) }]);

describe('release version preparation', () => {
    it('compares strict SemVer without runtime dependencies in the pre-install CI boundary', () => {
        expect(isStrictlyNewerVersion('0.0.25', '0.0.24')).toBe(true);
        expect(isStrictlyNewerVersion('1.0.0', '1.0.0-rc.1')).toBe(true);
        expect(isStrictlyNewerVersion('1.0.0-rc.10', '1.0.0-rc.2')).toBe(true);
        expect(isStrictlyNewerVersion('1.0.0+next', '1.0.0+previous')).toBe(false);
        expect(isStrictlyNewerVersion('1.2', '1.1.9')).toBe(false);
        expect(isStrictlyNewerVersion('1.0.0-01', '1.0.0-1')).toBe(false);
    });

    it('updates every coupled version source and extension engine range', async () => {
        const cwd = await fixture();
        const sourcePaths = await discoverReleaseSourcePaths(cwd);
        const previousSources = new Map(
            await Promise.all(
                sourcePaths.map(
                    async (path) => [path, await readFile(join(cwd, path), 'utf8')] as const,
                ),
            ),
        );
        const readPreviousSource: ReleaseSourceReader = async (path) => {
            const source = previousSources.get(path);
            if (source === undefined) throw new Error(`Missing previous source for ${path}`);
            return source;
        };

        const result = await prepareRelease(cwd, 'patch');

        expect(result).toMatchObject({
            previousVersion: '0.0.24',
            version: '0.0.25',
        });
        expect(result.changedPaths).toHaveLength(13);
        expect(sourcePaths).toEqual(result.changedPaths);
        await expect(
            isExactReleasePreparationDelta(cwd, result.changedPaths, readPreviousSource),
        ).resolves.toBe(true);
        await expect(
            isExactReleasePreparationDelta(
                cwd,
                [...result.changedPaths, 'apps/desktop/src/main/index.ts'],
                readPreviousSource,
            ),
        ).resolves.toBe(false);
        await expect(
            isExactReleasePreparationDelta(cwd, result.changedPaths.slice(1), readPreviousSource),
        ).resolves.toBe(false);
        const updatedManifests = await Promise.all(
            manifests.map(async (path) => ({
                manifest: JSON.parse(await readFile(join(cwd, path), 'utf8')) as {
                    engines?: { caxri?: string };
                    version: string;
                },
                path,
            })),
        );
        for (const { manifest, path } of updatedManifests) {
            expect(manifest.version, path).toBe('0.0.25');
            if (extensions.has(path)) expect(manifest.engines?.caxri, path).toBe('^0.0.25');
        }
        await expect(readFile(join(cwd, 'apps/cli/src/version.ts'), 'utf8')).resolves.toContain(
            "CLI_VERSION = '0.0.25'",
        );
        await expect(
            readFile(join(cwd, 'packages/agent-skills/src/version.ts'), 'utf8'),
        ).resolves.toContain("SKILL_BUNDLE_VERSION = '0.0.25'");

        const rootManifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>;
        };
        rootManifest.scripts = { release: 'unexpected' };
        await writeFile(
            join(cwd, 'package.json'),
            `${JSON.stringify(rootManifest, undefined, 4)}\n`,
            'utf8',
        );
        await expect(
            isExactReleasePreparationDelta(cwd, result.changedPaths, readPreviousSource),
        ).resolves.toBe(false);
    });

    it('validates all current sources before writing any changes', async () => {
        const mismatchedManifest = `${JSON.stringify(
            { engines: { caxri: '^0.0.23' }, version: '0.0.24' },
            undefined,
            4,
        )}\n`;
        const cwd = await fixture({ 'extensions/status/package.json': mismatchedManifest });
        const originalRoot = await readFile(join(cwd, 'package.json'), 'utf8');

        await expect(prepareRelease(cwd, 'patch')).rejects.toThrow('engines.caxri');
        await expect(readFile(join(cwd, 'package.json'), 'utf8')).resolves.toBe(originalRoot);
    });

    it('requires a clean checkout at the fetched origin/main before the CLI mutates files', async () => {
        const cwd = await fixture();
        const gitCalls: string[] = [];
        const recordingGit = cleanReleaseGit({ 'branch --show-current': 'release/v0.0.25' });

        await expect(
            assertReleaseSource(cwd, async (arguments_, root) => {
                gitCalls.push(arguments_.join(' '));
                return recordingGit(arguments_, root);
            }),
        ).resolves.toBeUndefined();
        expect(gitCalls.indexOf('fetch --quiet origin main')).toBeLessThan(
            gitCalls.indexOf('rev-parse refs/remotes/origin/main'),
        );
        expect(gitCalls).toContain('fetch --quiet origin main');
        await expect(
            assertReleaseSource(
                cwd,
                cleanReleaseGit({ 'status --porcelain --untracked-files=all': ' M package.json' }),
            ),
        ).rejects.toThrow('clean worktree');
        await expect(
            assertReleaseSource(
                cwd,
                cleanReleaseGit({ 'rev-parse refs/remotes/origin/main': 'remote-head' }),
            ),
        ).rejects.toThrow('match origin/main');

        await expect(
            runPrepareRelease(['0.0.25'], cwd, cleanReleaseGit(), greenMainCi),
        ).resolves.toMatchObject({
            version: '0.0.25',
        });
        await expect(runPrepareRelease([], cwd, cleanReleaseGit(), greenMainCi)).rejects.toThrow(
            'Usage',
        );
    });

    it('rejects malformed, unchanged, and older explicit versions', async () => {
        const malformed = await fixture();
        await expect(prepareRelease(malformed, 'next')).rejects.toThrow('major, minor, patch');

        const unchanged = await fixture();
        await expect(prepareRelease(unchanged, '0.0.24')).rejects.toThrow('must be newer');

        const older = await fixture();
        await expect(prepareRelease(older, '0.0.23')).rejects.toThrow('must be newer');
    });
});

describe('assertMainCiHealthy', () => {
    const run = (conclusion: string, displayTitle: string) => ({
        conclusion,
        displayTitle,
        headSha: 'b'.repeat(40),
    });

    it('refuses when the latest non-release run failed, even behind a green release run', async () => {
        await expect(
            assertMainCiHealthy(async () =>
                JSON.stringify([
                    run('success', 'release: v0.0.122'),
                    run('failure', 'feat: x (#2313)'),
                ]),
            ),
        ).rejects.toThrow('failed');
    });

    it('passes when the latest non-release run succeeded or no runs exist', async () => {
        await expect(
            assertMainCiHealthy(async () =>
                JSON.stringify([run('failure', 'release: v0.0.121'), run('success', 'fix: y')]),
            ),
        ).resolves.toBeUndefined();
        await expect(assertMainCiHealthy(async () => '[]')).resolves.toBeUndefined();
    });
});
