import type { AgentChatDiffLine } from '@caxri/protocol';
import { gitFileDiffTabPath } from '@caxri/protocol';

/**
 * The part of a `git.summary` result that locates a changed file: each repository's root and the files Git reports as
 * changed in it.
 */
export interface AgentChatChangeRepositories {
    repositories: ReadonlyArray<{
        id: string;
        rootPath: string;
        files: ReadonlyArray<{ path: string }>;
    }>;
}

/**
 * The Git diff tab for a file an Agent changed, so the user can review the change with the full diff editor instead of
 * the transcript's bounded preview. The file belongs to the innermost repository whose root contains it (a nested
 * repository wins over its parent), and only a file that repository still reports as changed has a diff to show;
 * otherwise `undefined`, and the transcript offers no Open diff.
 */
export function agentChatChangeDiffTabPath(
    summary: AgentChatChangeRepositories | undefined,
    absolutePath: string,
): string | undefined {
    let match: { id: string; relativePath: string; rootLength: number } | undefined;
    const repos = summary?.repositories ?? [];
    for (const repo of repos) {
        const root = repo.rootPath.replace(/\/+$/u, '');
        if (!root || !absolutePath.startsWith(`${root}/`)) continue;
        if (match && match.rootLength >= root.length) continue;
        const relativePath = absolutePath.slice(root.length + 1);
        if (repo.files.every((file) => file.path !== relativePath)) continue;
        match = { id: repo.id, relativePath, rootLength: root.length };
    }
    return match && gitFileDiffTabPath(match.id, match.relativePath);
}

/**
 * The line a changed file opens at: the first line the change added, else the first line of its first hunk, so the
 * Editor lands on the change instead of the top of the file. `undefined` when the diff names no new-side line (a
 * deletion, or no diff at all).
 */
export function agentChatChangeFirstLine(lines: readonly AgentChatDiffLine[]): number | undefined {
    return (
        lines.find((line) => line.kind === 'added' && line.newLine !== undefined)?.newLine ??
        lines.find((line) => line.newLine !== undefined)?.newLine
    );
}
