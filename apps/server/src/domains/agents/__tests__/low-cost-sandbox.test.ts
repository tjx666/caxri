import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareLowCostSandbox } from '../low-cost-sandbox';

const directories: string[] = [];
afterEach(async () => {
    const pending = [...directories];
    directories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'caxri-sandbox-boundary-'));
    directories.push(root);
    const projectDirectory = join(root, 'project');
    const configDirectory = join(root, 'config');
    const isolatedDirectory = join(root, 'isolated');
    const runtime = join(root, 'runtime');
    await Promise.all(
        [projectDirectory, configDirectory, isolatedDirectory, runtime].map((path) => mkdir(path)),
    );
    const executable = join(runtime, 'fake-cli');
    await writeFile(executable, 'fixture');
    return {
        projectDirectory,
        configDirectory,
        isolatedDirectory,
        executable,
        instructionNames: ['INSTRUCTIONS.md'],
        platform: 'darwin' as const,
    };
}

describe('Low-cost generation sandbox preflight', () => {
    it.each(['configDirectory', 'isolatedDirectory'] as const)(
        'rejects a Project containing %s',
        async (key) => {
            const options = await fixture();
            await expect(
                prepareLowCostSandbox({ ...options, projectDirectory: options[key] }),
            ).rejects.toMatchObject({
                code: 'UNAVAILABLE',
                details: { reason: 'sandboxBoundaryConflict' },
            });
        },
    );

    it('rejects an executable symlink targeting the denied Project', async () => {
        const options = await fixture();
        const executable = join(options.projectDirectory, 'runtime');
        await writeFile(executable, 'fixture');
        const link = join(options.configDirectory, 'cli-link');
        await symlink(executable, link);
        await expect(prepareLowCostSandbox({ ...options, executable: link })).rejects.toMatchObject(
            {
                details: { reason: 'sandboxBoundaryConflict' },
            },
        );
    });

    it('resolves an absent config home against its existing ancestor', async () => {
        const options = await fixture();
        await expect(
            prepareLowCostSandbox({
                ...options,
                configDirectory: join(options.projectDirectory, 'absent', 'provider'),
            }),
        ).rejects.toMatchObject({
            details: { reason: 'sandboxBoundaryConflict' },
        });
    });

    it.each(['executable', 'configDirectory'] as const)(
        'rejects a %s entry inside the Project even when its target is outside',
        async (key) => {
            const options = await fixture();
            const entry = join(options.projectDirectory, 'external-runtime');
            await symlink(options[key], entry);
            await expect(prepareLowCostSandbox({ ...options, [key]: entry })).rejects.toMatchObject(
                {
                    details: { reason: 'sandboxBoundaryConflict' },
                },
            );
        },
    );

    it('allows absent instruction files but fails closed on a symlink loop', async () => {
        const options = await fixture();
        const sandbox = await prepareLowCostSandbox(options);
        expect(sandbox.executable).toBe('/usr/bin/sandbox-exec');
        expect(sandbox.arguments.join(' ')).toContain('INSTRUCTIONS.md');
        await symlink('INSTRUCTIONS.md', join(options.configDirectory, 'INSTRUCTIONS.md'));
        await expect(prepareLowCostSandbox(options)).rejects.toMatchObject({
            code: 'UNAVAILABLE',
            details: { reason: 'sandboxPathUnavailable' },
        });
    });

    it('fails with a closed reason on a host that has no supported sandbox', async () => {
        const options = await fixture();
        await expect(
            prepareLowCostSandbox({ ...options, platform: 'win32' }),
        ).rejects.toMatchObject({
            code: 'UNAVAILABLE',
            details: { reason: 'sandboxUnavailable' },
        });
    });
});
