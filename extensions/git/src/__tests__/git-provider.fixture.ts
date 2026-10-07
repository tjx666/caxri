import './host-api.fixture';

import type { CaxriApi, GitCommitDetails, GitCommitPage, GitSummary, WorkspaceGit } from 'caxri';
import { vi } from 'vitest';

import { GitProvider } from '../git-provider';

export const repo = {
    id: 'repo-1',
    kind: 'primary' as const,
    name: 'project',
    rootPath: '/authorized/project',
    branch: 'main',
    head: '0123456789abcdef0123456789abcdef01234567',
    ahead: 1,
    behind: 2,
    additions: 3,
    deletions: 4,
    generation: 7,
    changedFileCount: 1,
    truncated: false,
    files: [
        {
            path: 'src/extension.ts',
            index: ' ',
            workingTree: 'M',
            kind: 'modified' as const,
        },
    ],
};

export const summary: GitSummary = {
    isRepository: true,
    repositories: [repo],
};

export const commitDetails: GitCommitDetails = {
    commit: {
        sha: repo.head,
        shortSha: '0123456',
        subject: 'Own Git product semantics',
        body: 'Move Source Control projection into the extension.',
        author: 'Octocat',
        authorEmail: '12345+octocat@users.noreply.github.com',
        authoredAt: 1_700_000_000_000,
        decorations: ['HEAD -> main'],
        parents: [],
    },
    additions: 3,
    deletions: 4,
    files: [{ path: 'src/extension.ts', status: 'modified' }],
    filesTruncated: false,
};

const commitPage: GitCommitPage = {
    commits: [commitDetails.commit],
};
export const scopeId = 'session-a:project-a';

export function createHarness(
    options: { avatars?: boolean; diffExclude?: Readonly<Record<string, boolean>> } = {},
) {
    const git = {
        summary: vi.fn<WorkspaceGit['summary']>(() => Promise.resolve(summary)),
        sync: vi.fn<WorkspaceGit['sync']>(() => Promise.resolve()),
        discard: vi.fn<WorkspaceGit['discard']>(() => Promise.resolve(null)),
        mergePullRequest: vi.fn<WorkspaceGit['mergePullRequest']>(() =>
            Promise.resolve({ method: 'squash' }),
        ),
        pullRequestChanges: vi.fn<WorkspaceGit['pullRequestChanges']>(() => Promise.resolve(null)),
        commits: vi.fn<WorkspaceGit['commits']>(() => Promise.resolve(commitPage)),
        commitDetails: vi.fn<WorkspaceGit['commitDetails']>(() => Promise.resolve(commitDetails)),
        remoteHost: vi.fn<WorkspaceGit['remoteHost']>(() => Promise.resolve('github.com')),
    } satisfies WorkspaceGit;
    const getConfigRequest =
        vi.fn<(key: string) => Promise<boolean | Readonly<Record<string, boolean>> | undefined>>();
    getConfigRequest.mockImplementation((key) =>
        Promise.resolve(key === 'git.diffExclude' ? options.diffExclude : options.avatars),
    );
    const getConfig: CaxriApi['workspace']['getConfiguration'] = async <Value = unknown>(
        key: string,
    ): Promise<Value | undefined> => (await getConfigRequest(key)) as Value | undefined;
    const workspace: Pick<CaxriApi['workspace'], 'getConfiguration' | 'git'> = {
        getConfiguration: getConfig,
        git,
    };
    return { getConfiguration: getConfigRequest, git, provider: new GitProvider(workspace) };
}
