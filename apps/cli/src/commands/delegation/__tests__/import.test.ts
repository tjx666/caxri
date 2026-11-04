import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CaxriError } from '@caxri/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';

import { runCli } from '../../../application';
import { DELEGATION_IMPORT_COMMAND } from '../import';

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

it('reads only an explicit bounded JSONC file and defaults to a non-mutating preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-import-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'source.jsonc');
    const source = `// Synthetic configuration\n${JSON.stringify(config)}`;
    await writeFile(path, source);
    const preview = await DELEGATION_IMPORT_COMMAND.parseParams(['--from', path]);
    expect(preview).toEqual({ dryRun: true, mode: 'merge', sourceText: source });
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
    expect(
        await DELEGATION_IMPORT_COMMAND.parseParams(['--from', path, '--replace', '--apply']),
    ).toMatchObject({ mode: 'replace', dryRun: false });
    await expect(
        DELEGATION_IMPORT_COMMAND.parseParams(['--from', path, '--merge', '--replace']),
    ).rejects.toThrow();
    const link = join(directory, 'link.jsonc');
    await symlink(path, link);
    await expect(DELEGATION_IMPORT_COMMAND.parseParams(['--from', link])).rejects.toThrow();
    await writeFile(path, 'x'.repeat(262_145));
    await expect(DELEGATION_IMPORT_COMMAND.parseParams(['--from', path])).rejects.toThrow(
        '256 KiB',
    );
});

it('prints rejected-import issues from details and requires a matching Server', () => {
    expect(DELEGATION_IMPORT_COMMAND).toMatchObject({ requiresServerVersionMatch: true });
    const error = DELEGATION_IMPORT_COMMAND.describeError?.(
        new CaxriError('VALIDATION', 'Delegation presets could not be imported', {
            issues: [{ stage: 'source', path: 'agents.0', reason: 'unknown_field' }],
        }),
    );
    expect(error?.message).toBe('Invalid delegation configuration: agents.0: unknown_field');
    expect(
        DELEGATION_IMPORT_COMMAND.describeError?.(new CaxriError('CONFLICT', 'x')),
    ).toBeUndefined();
});
