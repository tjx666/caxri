import { isAbsolute, relative } from 'node:path';

import type {
    GitSummary,
    TerminalCommitLinkCandidate,
    TerminalCommitLinkResolution,
    TerminalReferenceContext,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { parseGitHubRemote } from '@caxri/utils';

export async function loadTerminalReferenceContext(
    summary: GitSummary,
    readOriginRemote: (rootPath: string) => Promise<string>,
): Promise<TerminalReferenceContext> {
    const remotes = await Promise.all(
        summary.repositories.map(async ({ rootPath }) =>
            parseGitHubRemote(await readOriginRemote(rootPath)),
        ),
    );
    const unique = new Map<string, NonNullable<(typeof remotes)[number]>>();
    for (const remote of remotes) {
        if (!remote) continue;
        const key = `${remote.owner}/${remote.repo}`.toLowerCase();
        if (!unique.has(key)) unique.set(key, remote);
    }
    return { githubRepositories: unique.values().toArray() };
}

function isInsideRepo(rootPath: string, terminalCwd: string): boolean {
    const path = relative(rootPath, terminalCwd);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * Expands one untrusted short hash only inside repositories authorized for the Terminal's Session.
 */
export async function resolveTerminalCommitLink(
    summary: GitSummary,
    reference: string,
    terminalCwd: string,
    runGit: (rootPath: string, arguments_: string[]) => Promise<string>,
): Promise<TerminalCommitLinkResolution> {
    if (!/^[0-9a-f]{7,40}$/i.test(reference))
        throw new CaxriError('VALIDATION', 'Git commit reference is invalid');
    const candidates = (
        await Promise.all(
            summary.repositories.map(async (repo) => {
                const commitPeel = ['^', '{', 'commit', '}'].join('');
                const sha = (
                    await runGit(repo.rootPath, [
                        'rev-parse',
                        '--verify',
                        '--end-of-options',
                        reference + commitPeel,
                    ])
                ).trim();
                if (!/^[0-9a-f]{40}$/.test(sha)) return;
                return {
                    repositoryId: repo.id,
                    repositoryName: repo.name,
                    sha,
                    kind: repo.kind,
                    rootPath: repo.rootPath,
                };
            }),
        )
    ).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    if (candidates.length === 0)
        throw new CaxriError('NOT_FOUND', 'Git commit was not found in this Project');

    const bySha = Map.groupBy(candidates, ({ sha }) => sha);
    if (bySha.size === 1) {
        const sameCommit = bySha.values().next().value!;
        const selected =
            sameCommit
                .filter(({ rootPath }) => isInsideRepo(rootPath, terminalCwd))
                .toSorted((left, right) => right.rootPath.length - left.rootPath.length)
                .at(0) ??
            sameCommit.find(({ kind }) => kind === 'primary') ??
            sameCommit[0];
        return {
            status: 'resolved',
            candidate: {
                repositoryId: selected.repositoryId,
                repositoryName: selected.repositoryName,
                sha: selected.sha,
            },
        };
    }
    return {
        status: 'ambiguous',
        candidates: candidates.map(
            ({ repositoryId, repositoryName, sha }): TerminalCommitLinkCandidate => ({
                repositoryId,
                repositoryName,
                sha,
            }),
        ),
    };
}
