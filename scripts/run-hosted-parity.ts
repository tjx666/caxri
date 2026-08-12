#!/usr/bin/env bun

import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');

export const hostedParityCases = [
    {
        id: 'late-raw-mode',
        match: 'Bug report preview sends one redacted multiline prompt',
        seam: '750ms delay before raw mode, input capture, and ready marker',
        spec: 'e2e/bug-report.e2e.ts',
    },
    {
        id: 'extra-sigwinch',
        match: 'restored .* Terminal renders its cursor-addressed first screen',
        seam: 'two window resizes with repeated stable guest and rendered grids',
        spec: 'e2e/terminal-recovery.e2e.ts',
    },
    {
        id: 'transient-enoent',
        match: 'Files supports safe create, clipboard, reveal, Terminal, move, and Trash workflows',
        seam: 'copied target absent for 150ms while readiness polling continues',
        spec: 'e2e/file-operations.e2e.ts',
    },
    {
        id: 'long-path-wrapped-terminal',
        match: 'Terminal selection copies exact text and stays isolated across split panes',
        seam: 'three long path segments, a 720px window, and cross-row selection',
        spec: 'e2e/terminal-selection.e2e.ts',
    },
] as const;

export function hostedParityEnvironment(id: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        CAXRI_E2E_OUTPUT_DIR: `test-results/hosted-parity/${id}`,
        CAXRI_HOSTED_PARITY_CASE: id,
    };
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<number> {
    const child = spawn(command, args, {
        cwd: projectRoot,
        env: environment,
        stdio: 'inherit',
    });
    return new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
    });
}

async function main(): Promise<void> {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
        await appendFile(
            summary,
            [
                '## Hosted-parity matrix',
                '',
                '| Case | Deterministic seam | Spec | Repetitions |',
                '| --- | --- | --- | ---: |',
                ...hostedParityCases.map(
                    ({ id, seam, spec }) => `| \`${id}\` | ${seam} | \`${spec}\` | 3 |`,
                ),
                '',
            ].join('\n'),
        );
    }
    for (const parityCase of hostedParityCases) {
        const exitCode = await run(
            'bunx',
            [
                'playwright',
                'test',
                parityCase.spec,
                '-g',
                parityCase.match,
                '--workers=1',
                '--repeat-each=3',
                '--reporter=line',
            ],
            hostedParityEnvironment(parityCase.id),
        );
        if (exitCode !== 0) {
            process.exitCode = exitCode;
            return;
        }
    }
}

if (import.meta.main) await main();
