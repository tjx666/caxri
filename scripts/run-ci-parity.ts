#!/usr/bin/env bun

import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { runChildProcess } from './exec';
import { playwrightReporterArgument } from './reporters/public-e2e-reporter-policy';

const projectRoot = resolve(import.meta.dirname, '..');

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-parity.test.ts
export const ciParityCases = [
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
        match: String.raw`Cmd\+C copies the focused Editor or Terminal selection across split panes`,
        seam: 'three long path segments, a 720px window, and cross-row selection',
        spec: 'e2e/terminal-selection.e2e.ts',
    },
] as const;

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/run-ci-parity.test.ts
export function ciParityEnvironment(id: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        CAXRI_CI_PARITY_CASE: id,
        CAXRI_E2E_OUTPUT_DIR: `test-results/ci-parity/${id}`,
    };
}

function run(
    command: string,
    arguments_: string[],
    environment: NodeJS.ProcessEnv,
): Promise<number> {
    return runChildProcess(command, arguments_, {
        cwd: projectRoot,
        env: environment,
        stdio: 'inherit',
    });
}

async function main(): Promise<void> {
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
        await appendFile(
            summary,
            [
                '## CI-parity matrix',
                '',
                '| Case | Deterministic seam | Spec | Repetitions |',
                '| --- | --- | --- | ---: |',
                ...ciParityCases.map(
                    ({ id, seam, spec }) => `| \`${id}\` | ${seam} | \`${spec}\` | 3 |`,
                ),
                '',
            ].join('\n'),
        );
    }
    for (const parityCase of ciParityCases) {
        // CI-parity cases run sequentially with a shared single Playwright worker and fail fast on
        // the first regression, so concurrent execution would break both properties.
        // eslint-disable-next-line no-await-in-loop -- sequential fail-fast CI-parity matrix
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
                playwrightReporterArgument(),
            ],
            ciParityEnvironment(parityCase.id),
        );
        if (exitCode !== 0) {
            process.exitCode = exitCode;
            return;
        }
    }
}

if (import.meta.main) await main();
