import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { runCli } from '../application';
import { convertDelegationConfig, DELEGATION_IMPORT_COMMAND } from '../commands/delegation-import';

const config = {
    maxDepth: 2,
    agents: [
        {
            name: 'review',
            harness: 'claude',
            model: 'opus',
            effort: 'xhigh',
            useWhen: 'Review a change',
            instructions: 'Synthetic private instructions',
        },
    ],
    callers: {
        claude: {
            agents: { review: { harness: 'codex', useWhen: 'Independent review' } },
            prepend: 'Synthetic caller instructions',
            append: 'Synthetic closing instructions',
        },
    },
};

it('preserves private instructions and whole caller binding replacements', () => {
    const result = convertDelegationConfig(config);
    expect(result.presets[0]).toMatchObject({
        name: 'review',
        provider: 'claude',
        model: 'opus',
        effort: 'xhigh',
        instructions: 'Synthetic private instructions',
    });
    expect(result.callers.claude?.presets?.review).toEqual({
        provider: 'codex',
        useWhen: 'Independent review',
    });
    expect(result.callers.claude?.prepend).toBe(config.callers.claude.prepend);
    expect(
        convertDelegationConfig({ ...config, callers: { grok: { exclude: ['review'] } } }).callers
            .grok?.exclude,
    ).toEqual(['review']);
});

it.each([
    { agents: [{ ...config.agents[0], name: 'Invalid Name' }] },
    { agents: [{ ...config.agents[0], harness: 'grok', effort: 'xhigh' }] },
    { agents: [{ ...config.agents[0], useWhen: 'x'.repeat(2049) }] },
    { agents: [{ ...config.agents[0], instructions: 'x'.repeat(8193) }] },
    {
        agents: Array.from({ length: 33 }, (_, index) => ({
            ...config.agents[0],
            name: `preset-${index}`,
        })),
    },
    { callers: { claude: { exclude: ['unknown'] } } },
    { callers: { claude: { exclude: ['review'], agents: { review: { harness: 'codex' } } } } },
    { maxDepth: 9 },
    { unknown: true },
])('rejects incompatible source semantics: %j', (changes) => {
    expect(() => convertDelegationConfig({ ...config, ...changes })).toThrow();
});

it('reads only an explicit bounded JSONC file and defaults to a non-mutating preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-import-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'source.jsonc');
    const source = `// Synthetic configuration\n${JSON.stringify(config)}`;
    await writeFile(path, source);
    const preview = await DELEGATION_IMPORT_COMMAND.parseParams(['--from', path]);
    expect(preview).toMatchObject({ dryRun: true, settings: { maxDepth: 2 } });
    expect(DELEGATION_IMPORT_COMMAND.mutates?.(preview)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(source);
    const connect = vi.fn();
    const io = {
        stdinIsTTY: false,
        stdoutIsTTY: false,
        stderrIsTTY: false,
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
    };
    const results = await Promise.all(
        [
            { CODEX_THREAD_ID: 'synthetic' },
            { CLAUDECODE: '1' },
            { GROK_SESSION_ID: 'synthetic' },
        ].map((environment) =>
            runCli(
                [
                    'agent',
                    'delegate',
                    'import',
                    '--from',
                    path,
                    '--apply',
                    '--profile',
                    directory,
                    '--yes',
                ],
                { connect, io, environment },
            ),
        ),
    );
    expect(results.every((code) => code !== 0)).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expect(io.writeStderr.mock.calls.flat().join('')).toContain('human profile owner');
    expect(await DELEGATION_IMPORT_COMMAND.parseParams(['--from', path, '--apply'])).toMatchObject({
        dryRun: false,
    });
    await expect(
        DELEGATION_IMPORT_COMMAND.parseParams(['--from', path, '--apply', '--dry-run']),
    ).rejects.toThrow();
    await expect(DELEGATION_IMPORT_COMMAND.parseParams([])).rejects.toThrow();
    await writeFile(
        path,
        JSON.stringify({ ...config, agents: [{ ...config.agents[0], harness: 'grok' }] }),
    );
    await expect(DELEGATION_IMPORT_COMMAND.parseParams(['--from', path])).rejects.toThrow(
        'Unsupported effort for delegation preset review',
    );
    await writeFile(
        path,
        JSON.stringify({ ...config, callers: { claude: { exclude: ['unknown'] } } }),
    );
    await expect(DELEGATION_IMPORT_COMMAND.parseParams(['--from', path])).rejects.toThrow(
        'excludes an unknown preset',
    );
    const link = join(directory, 'link.jsonc');
    await symlink(path, link);
    await expect(DELEGATION_IMPORT_COMMAND.parseParams(['--from', link])).rejects.toThrow();
    await writeFile(path, 'x'.repeat(1_048_577));
    await expect(DELEGATION_IMPORT_COMMAND.parseParams(['--from', path])).rejects.toThrow(
        '1024 KiB',
    );
});
