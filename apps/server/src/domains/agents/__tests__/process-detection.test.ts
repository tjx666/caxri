import { describe, expect, it } from 'vitest';

import {
    foregroundAgentProcessIdsFromProcessList,
    foregroundAgentProviderFromProcessList,
    openFilesFromLsofOutput,
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
