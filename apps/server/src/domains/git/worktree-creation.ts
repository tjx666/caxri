import { basename, dirname, join } from 'node:path';

import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { GitCommandOptions } from './command';
import { runGitCommand } from './command';
import { serverGitCommands } from './command-budget';

type GitRunner = (
    cwd: string,
    arguments_: string[],
    options?: GitCommandOptions,
) => Promise<string>;

/**
 * Checking out a large repository into a new worktree can outlast the 10s budget of metadata commands.
 */
const WORKTREE_CREATION_TIMEOUT_MS = 120_000;

/**
 * Where a new linked worktree for `branch` lives: beside the Project folder, in `<project>.worktrees/`, so the Project
 * tree never contains a second checkout of itself. Slashes in the branch name flatten to dashes.
 */
export function linkedWorktreePath(ownerRoot: string, branch: string): string {
    return join(
        dirname(ownerRoot),
        `${basename(ownerRoot)}.worktrees`,
        branch.replaceAll('/', '-'),
    );
}

/**
 * Creates a linked worktree on a new `branch` forked from the owner checkout's current HEAD and returns its path. A
 * branch name Git rejects or an existing branch or folder fails before anything is created; Git itself removes a
 * half-made worktree when its checkout fails.
 */
export async function createLinkedWorktree(
    git: GitRunner,
    input: { ownerRoot: string; branch: string },
): Promise<string> {
    const { ownerRoot, branch } = input;
    const checked = await git(ownerRoot, ['check-ref-format', '--branch', branch], {
        allowFailure: true,
    });
    // `--branch` also expands `@{-1}`-style shorthands; only the literal name is a new branch.
    if (checked.trim() !== branch || branch.startsWith('-'))
        throw new CaxriError('VALIDATION', 'The worktree branch name is not a valid new branch');
    const rootPath = linkedWorktreePath(ownerRoot, branch);
    await git(ownerRoot, ['worktree', 'add', '-b', branch, rootPath], {
        timeoutMs: WORKTREE_CREATION_TIMEOUT_MS,
    });
    return rootPath;
}

/**
 * {@link createLinkedWorktree} on the Server's shared Git command budget and structured `git.command` log.
 */
export function createServerLinkedWorktree(
    logger: StructuredLogger,
    input: { ownerRoot: string; branch: string },
): Promise<string> {
    return createLinkedWorktree(
        (cwd, arguments_, options) =>
            runGitCommand(serverGitCommands, logger, cwd, arguments_, options),
        input,
    );
}
