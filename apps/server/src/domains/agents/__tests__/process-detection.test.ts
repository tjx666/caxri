import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    foregroundAgentProcessIdsFromProcessList,
    foregroundAgentProviderFromProcessList,
    openFilesFromLsofOutput,
    openFilesFromProcFileSystem,
} from '../process-detection';

describe('Shell foreground Agent detection', () => {
    it.each([
        ['claude', '/opt/tools/claude'],
        ['codex', '/opt/tools/codex'],
    ] as const)('identifies a foreground %s descendant', (provider, executable) => {
        expect(
            foregroundAgentProviderFromProcessList(
                `100 1 100 200 /bin/zsh -l\n200 100 200 200 /usr/bin/node wrapper.js\n201 200 200 200 ${executable} --flag\n`,
                100,
            ),
        ).toBe(provider);
    });

    it('identifies an npm/pnpm shim agent running as an interpreter script image', () => {
        // pnpm's shell shim `exec`s the interpreter, so the agent's own process image is `node .../codex.js`.
        expect(
            foregroundAgentProviderFromProcessList(
                '100 1 100 200 /bin/zsh -l\n200 100 200 200 node /Users/u/Library/pnpm/global/node_modules/@openai/codex/bin/codex.js --flag\n',
                100,
            ),
        ).toBe('codex');
        expect(
            foregroundAgentProviderFromProcessList(
                '100 1 100 200 /bin/zsh -l\n200 100 200 200 /usr/local/bin/node --max-old-space-size=4096 /opt/agents/claude.mjs\n',
                100,
            ),
        ).toBe('claude');
        // An interpreter running an unrelated script must stay unidentified.
        expect(
            foregroundAgentProviderFromProcessList(
                '100 1 100 200 /bin/zsh -l\n200 100 200 200 node /srv/app/server.js\n',
                100,
            ),
        ).toBeUndefined();
    });

    it('ignores background Agents and ambiguous foreground process groups', () => {
        expect(
            foregroundAgentProviderFromProcessList(
                '100 1 100 300 /bin/zsh -l\n200 100 200 300 /opt/tools/codex\n300 100 300 300 /usr/bin/git status\n',
                100,
            ),
        ).toBeUndefined();
        expect(
            foregroundAgentProviderFromProcessList(
                '100 1 100 200 /bin/zsh -l\n200 100 200 200 /opt/tools/codex\n201 100 200 200 /opt/tools/claude\n',
                100,
            ),
        ).toBeUndefined();
    });

    it('returns foreground provider PIDs for the bounded open-file probe', () => {
        expect(
            foregroundAgentProcessIdsFromProcessList(
                '100 1 100 200 /bin/zsh -l\n200 100 200 200 node /opt/codex.js --flag\n201 200 200 200 /opt/helper\n',
                100,
                'codex',
            ),
        ).toEqual([200]);
        expect(
            foregroundAgentProcessIdsFromProcessList(
                '100 1 100 200 /bin/zsh -l\n200 100 200 200 /opt/tools/codex\n201 100 201 200 /opt/tools/codex\n',
                100,
                'codex',
            ),
        ).toEqual([200]);
    });

    it('parses lsof access fields and resets them for each descriptor', () => {
        expect(
            openFilesFromLsofOutput(
                'p200\nf4\nau\n/something\nn/Users/dev/.codex/sessions/2026/09/07/rollout.jsonl\nf5\nar\nn/Users/dev/.codex/state.sqlite\np201\nf3\naw\nn/Users/dev/.codex/other.jsonl\n',
            ),
        ).toEqual([
            {
                access: 'u',
                path: '/Users/dev/.codex/sessions/2026/09/07/rollout.jsonl',
                pid: 200,
            },
            {
                access: 'r',
                path: '/Users/dev/.codex/state.sqlite',
                pid: 200,
            },
            {
                access: 'w',
                path: '/Users/dev/.codex/other.jsonl',
                pid: 201,
            },
        ]);
    });
});

describe('Linux open-file probe', () => {
    it('reads file paths and access modes from /proc and skips non-file descriptors', async () => {
        const procRoot = await mkdtemp(join(tmpdir(), 'caxri-proc-'));
        try {
            const process = join(procRoot, '42');
            await mkdir(join(process, 'fd'), { recursive: true });
            await mkdir(join(process, 'fdinfo'));
            const entries = [
                ['3', '/home/dev/.codex/sessions/rollout-1.jsonl', '0100001'],
                ['4', '/home/dev/notes.txt', '0100000'],
                ['5', '/home/dev/state.db', '0100002'],
                ['6', 'socket:[12345]', '02'],
            ] as const;
            await Promise.all(
                entries.map(async ([descriptor, target, flags]) => {
                    await symlink(target, join(process, 'fd', descriptor));
                    await writeFile(
                        join(process, 'fdinfo', descriptor),
                        `pos:\t0\nflags:\t${flags}\nmnt_id:\t1\n`,
                    );
                }),
            );
            const files = await openFilesFromProcFileSystem([42, 43], procRoot);
            expect(files.toSorted((left, right) => left.path.localeCompare(right.path))).toEqual([
                { access: 'w', path: '/home/dev/.codex/sessions/rollout-1.jsonl', pid: 42 },
                { access: 'r', path: '/home/dev/notes.txt', pid: 42 },
                { access: 'u', path: '/home/dev/state.db', pid: 42 },
            ]);
        } finally {
            await rm(procRoot, { recursive: true, force: true });
        }
    });
});
