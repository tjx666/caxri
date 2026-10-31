#!/usr/bin/env bun

import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { verifyRevisionProvenance } from './ci-checks-worktree';
import { sanitizedChildEnvironment } from './ci-child-environment';
import { execFileAsync } from './exec';

const projectRoot = resolve(import.meta.dirname, '..');

function requiredEnvironment(environment: NodeJS.ProcessEnv, key: string): string {
    const value = environment[key];
    if (!value || value.includes('\n')) throw new Error(`${key} is required and must be one line`);
    return value;
}

/**
 * Exports the diff base for the `checks` job, which measures GitHub's synthetic merge ref directly. The payload base is
 * frozen when the event fires, so diffing the merge ref against it charges a pull request with every change `main`
 * gained since: the source-size ratchet once failed a PR on a file only `main` had grown. Pull requests therefore diff
 * against the merge ref's verified first parent; pushes keep the payload's `before` revision.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-checks-diff-base.test.ts
export async function exportChecksDiffBase(
    environment: NodeJS.ProcessEnv = process.env,
    repoRoot = projectRoot,
): Promise<string> {
    // A manual dispatch has no `before` revision; the diff consumers then fall back to their own default base.
    let baseRevision = environment.CAXRI_CHECKS_BASE_REVISION?.trim() ?? '';
    if (environment.GITHUB_EVENT_NAME === 'pull_request') {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
            cwd: repoRoot,
            env: sanitizedChildEnvironment(environment),
        });
        const provenance = await verifyRevisionProvenance(
            stdout.trim(),
            baseRevision,
            requiredEnvironment(environment, 'CAXRI_CHECKS_HEAD_REVISION'),
            true,
            repoRoot,
            environment,
        );
        baseRevision = provenance.baseRevision;
    }
    await appendFile(
        requiredEnvironment(environment, 'GITHUB_ENV'),
        `CAXRI_REACT_DOCTOR_BASE=${baseRevision}\n`,
        'utf8',
    );
    return baseRevision;
}

if (import.meta.main) await exportChecksDiffBase();
