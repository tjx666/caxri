import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { execFileAsync } from '../exec';

const workflow = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
);

interface WorkflowStep {
    name?: string;
    run?: string;
}

function stepScript(name: string): string {
    const parsed: unknown = parse(workflow);
    const steps: unknown = Reflect.get(
        Reflect.get(Reflect.get(parsed as object, 'jobs'), 'release'),
        'steps',
    );
    const step = (steps as WorkflowStep[]).find((entry) => entry.name === name);
    if (!step?.run) throw new Error(`Workflow step '${name}' has no run block`);
    return step.run;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pending = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { force: true, recursive: true })));
});

/**
 * Runs the workflow's own shell for the artifact step against a fake `release.noindex`, so the count assertion is
 * tested as written rather than re-implemented. Only the failing counts are executed here: the single-DMG path calls
 * `hdiutil verify`, which needs a real disk image.
 */
async function runArtifactStep(dmgNames: string[]): Promise<{ code: number; stderr: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-release-artifact-'));
    temporaryDirectories.push(directory);
    await execFileAsync('mkdir', ['-p', join(directory, 'release.noindex')]);
    for (const name of dmgNames) {
        // eslint-disable-next-line no-await-in-loop -- tiny fixture writes
        await writeFile(join(directory, 'release.noindex', name), 'not a disk image\n');
    }
    try {
        await execFileAsync(
            'bash',
            ['-eo', 'pipefail', '-c', stepScript('Verify release artifact')],
            {
                cwd: directory,
            },
        );
        return { code: 0, stderr: '' };
    } catch (error) {
        const failure = error as { code?: number; stderr?: string };
        return { code: failure.code ?? 1, stderr: failure.stderr ?? '' };
    }
}

describe('Release workflow contract', () => {
    it('routes trusted exact-head packaging to the dedicated self-hosted capability', () => {
        expect(workflow).toContain('runs-on: [self-hosted, macOS, ARM64, caxri-release]');
        expect(workflow).not.toContain('runs-on: macos-15');
        expect(workflow).toContain('uses: ./.github/actions/verify-trust-boundary');
        expect(workflow).toContain(
            "startsWith(github.event.workflow_run.display_title, 'release: v')",
        );
        expect(workflow).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
    });

    it('publishes exactly one freshly packaged DMG', async () => {
        // The regression (#944): `find -print -quit` took the first DMG it met, so a stale image left in
        // `release.noindex` by an earlier build could be published with a checksum computed over that stale file.
        expect(workflow).not.toContain('-print -quit');
        expect(workflow.indexOf('name: Clean previous packaging output')).toBeLessThan(
            workflow.indexOf('name: Package unsigned Apple Silicon DMG'),
        );
        expect(stepScript('Clean previous packaging output')).toBe('rm -rf release.noindex');

        const none = await runArtifactStep([]);
        expect(none.code).not.toBe(0);
        expect(none.stderr).toContain('No DMG was produced.');

        const two = await runArtifactStep(['Caxri-0.0.8-arm64.dmg', 'Caxri-0.0.9-arm64.dmg']);
        expect(two.code).not.toBe(0);
        expect(two.stderr).toContain('Expected exactly one DMG in release.noindex, found 2:');
        expect(two.stderr).toContain('Caxri-0.0.8-arm64.dmg');
        expect(two.stderr).toContain('Caxri-0.0.9-arm64.dmg');
    });

    it('stages the release-signed Android bundle before packaging and proves it shipped', () => {
        const bundle = stepScript('Build Android update bundle');
        expect(workflow.indexOf('name: Build Android update bundle')).toBeLessThan(
            workflow.indexOf('name: Package unsigned Apple Silicon DMG'),
        );
        expect(bundle).toContain('trap \'rm -f "$keystore"\' EXIT');
        expect(bundle).toContain('bun run --cwd apps/mobile build:update-bundle');
        expect(stepScript('Package unsigned Apple Silicon DMG')).toContain(
            'cmp out/mobile-update/caxri-mobile.apk',
        );
    });

    it('keeps publication credentials bounded and cleans the local runner', () => {
        expect(workflow).toContain('contents: write');
        expect(workflow).toContain('persist-credentials: false');
        expect(workflow).toContain('CAXRI_E2E_AGENT_MODE: blocked');
        expect(workflow).toContain('CAXRI_RUNNER_AGENT_DISCOVERY: blocked');
        expect(workflow).toContain('uses: ./.github/actions/setup-caxri-job');
        expect(workflow).toContain("setup-toolchain: 'true'");
        expect(workflow).toContain("install-dependencies: 'true'");
        expect(workflow).toContain("install-electron: 'true'");
        expect(workflow).not.toContain('rebuild-native:');
        expect(workflow).not.toContain('npm ci');
        expect(workflow.indexOf('name: Validate release commit')).toBeLessThan(
            workflow.indexOf('uses: ./.github/actions/setup-caxri-job'),
        );
        expect(workflow).not.toContain("require('./package.json').version");
        expect(workflow).toContain('bun run scripts/self-hosted-runner.ts cleanup');
        expect(workflow).toContain('name: Clean self-hosted runner boundary\n        if: always()');
        expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
        expect(workflow).toContain('gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/${tag}"');
        expect(workflow).not.toContain('git ls-remote');
    });
});
