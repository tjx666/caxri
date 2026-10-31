import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyRevisionProvenance } from '../ci-checks-worktree';

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];
/**
 * Base-drift verification fetches the merge ref base, so it needs the same command-scoped token as any fetch.
 */
const fetchEnvironment = { ...process.env, CAXRI_GITHUB_TOKEN: 'test-token' };

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, { cwd });
    return stdout.trim();
}

async function commitFile(cwd: string, name: string, content: string): Promise<string> {
    await writeFile(join(cwd, name), content, 'utf8');
    await git(cwd, 'add', name);
    await git(cwd, 'commit', '-m', name);
    return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * Reproduces the #609 timeline: the run is queued with `payloadBase`, another PR lands on the base branch, and GitHub
 * recomputes the PR merge ref on top of `advancedBase` while the head stays the same.
 */
async function driftedSyntheticMergeFixture() {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'caxri-base-drift-'));
    fixtureRoots.push(fixtureRoot);
    const source = join(fixtureRoot, 'source');
    const shallow = join(fixtureRoot, 'shallow');
    await git(fixtureRoot, 'init', '-b', 'main', source);
    await git(source, 'config', 'user.name', 'Caxri CI');
    await git(source, 'config', 'user.email', 'ci@caxri.test');
    const payloadBase = await commitFile(source, 'base.txt', 'base\n');

    await git(source, 'checkout', '-b', 'feature');
    const headRevision = await commitFile(source, 'feature.txt', 'feature\n');

    await git(source, 'checkout', '-b', 'detour', payloadBase);
    const detourBase = await commitFile(source, 'detour.txt', 'detour\n');

    await git(source, 'checkout', 'main');
    const advancedBase = await commitFile(source, 'landed.txt', 'another PR landed\n');

    await git(source, 'checkout', '-b', 'integration', advancedBase);
    await git(source, 'merge', '--no-ff', 'feature', '-m', 'synthetic merge');
    const mergeRevision = await git(source, 'rev-parse', 'HEAD');

    await git(
        fixtureRoot,
        'clone',
        '--depth=1',
        '--branch',
        'integration',
        `file://${source}`,
        shallow,
    );
    expect(await git(shallow, 'show', '-s', '--format=%P', 'HEAD')).toBe('');

    return {
        advancedBase,
        detourBase,
        headRevision,
        mergeRevision,
        payloadBase,
        shallow,
        source,
    };
}

afterEach(async () => {
    const pending = [...fixtureRoots];
    fixtureRoots.length = 0;
    await Promise.all(pending.map((root) => rm(root, { force: true, recursive: true })));
});

describe('checks worktree synthetic merge provenance', () => {
    it('continues with the merge ref base when the base branch advanced after the run was queued', async () => {
        const fixture = await driftedSyntheticMergeFixture();
        const log = vi.fn();

        await expect(
            verifyRevisionProvenance(
                fixture.mergeRevision,
                fixture.payloadBase,
                fixture.headRevision,
                true,
                fixture.shallow,
                fetchEnvironment,
                undefined,
                log,
            ),
        ).resolves.toEqual({
            baseDrift: {
                mergeReferenceBase: fixture.advancedBase,
                payloadBase: fixture.payloadBase,
            },
            baseRevision: fixture.advancedBase,
        });
        expect(log).toHaveBeenCalledWith(
            `CAXRI_CHECKS_BASE_DRIFT ${JSON.stringify({
                headRevision: fixture.headRevision,
                mergeReferenceBase: fixture.advancedBase,
                payloadBase: fixture.payloadBase,
            })}`,
        );
    });

    it('fails closed with every SHA and the rebase remediation when the merge ref head is stale', async () => {
        const fixture = await driftedSyntheticMergeFixture();
        const newerHead = 'f'.repeat(40);
        const log = vi.fn();

        const failure = verifyRevisionProvenance(
            fixture.mergeRevision,
            fixture.advancedBase,
            newerHead,
            true,
            fixture.shallow,
            fetchEnvironment,
            undefined,
            log,
        );
        await expect(failure).rejects.toThrow('Synthetic merge parents do not match');
        await expect(failure).rejects.toThrow(`payload base ${fixture.advancedBase}`);
        await expect(failure).rejects.toThrow(`merge-ref base ${fixture.advancedBase}`);
        await expect(failure).rejects.toThrow(`merge-ref head ${fixture.headRevision}`);
        await expect(failure).rejects.toThrow(`PR head ${newerHead}`);
        await expect(failure).rejects.toThrow(
            'rebase the PR onto the latest base branch and force-push',
        );
        await expect(failure).rejects.toThrow('cannot recover');
        expect(log).not.toHaveBeenCalled();
    });

    it('fails closed when the merge ref base does not descend from the payload base', async () => {
        const fixture = await driftedSyntheticMergeFixture();

        const failure = verifyRevisionProvenance(
            fixture.mergeRevision,
            fixture.detourBase,
            fixture.headRevision,
            true,
            fixture.shallow,
            fetchEnvironment,
            undefined,
            vi.fn(),
        );
        await expect(failure).rejects.toThrow('Synthetic merge parents do not match');
        await expect(failure).rejects.toThrow(
            `merge-ref base ${fixture.advancedBase} does not descend from payload base ${fixture.detourBase}`,
        );
        await expect(failure).rejects.toThrow(`PR head ${fixture.headRevision}`);
        await expect(failure).rejects.toThrow('force-push');
    });

    it('names every SHA and the remediation when the drifted base cannot be fetched', async () => {
        const fixture = await driftedSyntheticMergeFixture();
        await git(
            fixture.shallow,
            'remote',
            'set-url',
            'origin',
            `file://${fixture.source}-missing`,
        );

        const failure = verifyRevisionProvenance(
            fixture.mergeRevision,
            fixture.payloadBase,
            fixture.headRevision,
            true,
            fixture.shallow,
            fetchEnvironment,
            undefined,
            vi.fn(),
        );
        await expect(failure).rejects.toThrow('Synthetic merge parents do not match');
        await expect(failure).rejects.toThrow(
            `could not prove merge-ref base ${fixture.advancedBase} descends from payload base ${fixture.payloadBase}`,
        );
        await expect(failure).rejects.toThrow(`PR head ${fixture.headRevision}`);
        await expect(failure).rejects.toThrow(
            'rebase the PR onto the latest base branch and force-push',
        );
    });
});
