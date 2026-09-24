import { describe, expect, it } from 'vitest';

import type { CommandRunner } from '../intake-snapshot';
import { createIntakeSnapshot, parseIntakeSnapshotArguments } from '../intake-snapshot';

type FixtureResponse = string | Error;

function fixtureRunner(overrides: Record<string, FixtureResponse | FixtureResponse[]> = {}) {
    const calls: string[] = [];
    // Partial (not Record<string, string>): lookups below may use a command key that isn't
    // present in this fixture map, so the value genuinely can be `undefined`.
    const defaults: Partial<Record<string, string>> = {
        'gh api user --jq .login': 'builder\n',
        'gh api graphql --paginate': JSON.stringify([
            {
                id: 'project-item-65',
                number: 65,
                priority: 'P1 High',
                repository: 'tjx666/caxri',
                status: 'In Progress',
            },
        ]),
        'gh repo view tjx666/caxri --json nameWithOwner,defaultBranchRef': JSON.stringify({
            defaultBranchRef: { name: 'main' },
            nameWithOwner: 'tjx666/caxri',
        }),
        'git branch --show-current': 'feat/attention\n',
        'git rev-list --left-right --count origin/main...HEAD': '2\t3\n',
        'git rev-parse HEAD': 'head-sha\n',
        'git rev-parse origin/main': 'main-sha\n',
        'git status --short --untracked-files=all': ' M src/example.ts\n',
        'lh whoami --json': JSON.stringify({ userId: 'user-1' }),
    };
    const runner: CommandRunner = {
        capture(command, arguments_) {
            const exact = `${command} ${arguments_.join(' ')}`;
            calls.push(exact);
            const projectPrefix = 'gh api graphql --paginate ';
            const key = exact.startsWith(projectPrefix) ? projectPrefix.trimEnd() : exact;
            const configured = overrides[key];
            const value = Array.isArray(configured) ? configured.shift() : configured;
            const response = value ?? defaults[key];
            if (response === undefined) throw new Error(`Unexpected command: ${exact}`);
            if (response instanceof Error) return Promise.reject(response);
            return Promise.resolve(response);
        },
    };
    return { calls, runner };
}

const issues = JSON.stringify([
    {
        labels: [{ name: 'enhancement' }],
        number: 65,
        state: 'CLOSED',
        title: 'Persist Session attention',
        updatedAt: '2026-08-11T00:00:00Z',
        url: 'https://github.com/tjx666/caxri/issues/65',
    },
    {
        labels: [],
        number: 66,
        state: 'OPEN',
        title: 'Manage worktrees',
        updatedAt: '2026-08-11T00:00:00Z',
        url: 'https://github.com/tjx666/caxri/issues/66',
    },
]);

const pullRequests = JSON.stringify([
    {
        baseRefName: 'main',
        closingIssuesReferences: [
            {
                number: 65,
                repository: { name: 'caxri', owner: { login: 'tjx666' } },
            },
        ],
        headRefName: 'feat/attention',
        headRefOid: 'head-sha',
        isDraft: false,
        number: 74,
        state: 'MERGED',
        title: 'Persist attention',
        updatedAt: '2026-08-11T00:00:00Z',
        url: 'https://github.com/tjx666/caxri/pull/74',
    },
    {
        baseRefName: 'main',
        closingIssuesReferences: [
            { number: 66, repository: { name: 'caxri', owner: { login: 'tjx666' } } },
        ],
        headRefName: 'feat/unrelated',
        headRefOid: 'unrelated-sha',
        isDraft: false,
        number: 75,
        state: 'CLOSED',
        title: 'Unrelated closed PR',
        updatedAt: '2026-08-11T00:00:00Z',
        url: 'https://github.com/tjx666/caxri/pull/75',
    },
]);

describe('Go intake snapshot', () => {
    it('collects bounded live state and joins requested issues to Project and PR metadata', async () => {
        const issueCommand =
            'gh issue list --repo tjx666/caxri --state all --limit 1000 --json number,title,state,url,labels,updatedAt';
        const pullRequestCommand =
            'gh pr list --repo tjx666/caxri --state all --limit 1000 --json number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,updatedAt,closingIssuesReferences';
        const { calls, runner } = fixtureRunner({
            [issueCommand]: issues,
            [pullRequestCommand]: pullRequests,
        });

        const snapshot = await createIntakeSnapshot(
            {
                cwd: '/repo',
                fetch: false,
                issueNumbers: [65],
                projectNumber: 2,
                repository: 'tjx666/caxri',
            },
            runner,
            '2026-08-11T01:00:00Z',
        );

        expect(snapshot).toMatchObject({
            authenticatedAs: 'builder',
            capturedAt: '2026-08-11T01:00:00Z',
            lobeHubAuthenticated: true,
            issues: [
                {
                    acceptanceCheckIds: [],
                    classification: null,
                    number: 65,
                    priority: 'P1 High',
                    projectItemId: 'project-item-65',
                    projectStatus: 'In Progress',
                    relatedPullRequests: [74],
                    userVisibleOutcome: null,
                },
            ],
            source: {
                ahead: 3,
                behind: 2,
                changedFileCount: 1,
                clean: false,
                defaultBranchSha: 'main-sha',
                fetchedOrigin: false,
                headSha: 'head-sha',
            },
        });
        expect(calls).toContain(issueCommand);
        expect(calls).toContain('lh whoami --json');
        const projectCall = calls.find((call) => call.startsWith('gh api graphql --paginate '));
        expect(projectCall).toContain('owner=tjx666');
        expect(projectCall).toContain('number=2');
        // `gh project item-list` bills every item's full field catalog; intake must stay on the named-field query.
        expect(calls.some((call) => call.startsWith('gh project'))).toBe(false);
        expect(calls.some((call) => call.includes('.content.body'))).toBe(false);
        expect(snapshot.pullRequests.map(({ number }) => number)).toEqual([74]);
    });

    it('joins Project items from every paginated page', async () => {
        const item = (number: number, status: string) => ({
            id: `project-item-${number}`,
            number,
            priority: null,
            repository: 'tjx666/caxri',
            status,
        });
        const { runner } = fixtureRunner({
            'gh api graphql --paginate': `${JSON.stringify([item(1, 'Done')])}\n${JSON.stringify([item(65, 'Next')])}\n`,
            'gh issue list --repo tjx666/caxri --state all --limit 1000 --json number,title,state,url,labels,updatedAt':
                issues,
            'gh pr list --repo tjx666/caxri --state all --limit 1000 --json number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,updatedAt,closingIssuesReferences':
                pullRequests,
        });

        const snapshot = await createIntakeSnapshot(
            {
                cwd: '/repo',
                fetch: false,
                issueNumbers: [65],
                projectNumber: 2,
                repository: 'tjx666/caxri',
            },
            runner,
        );

        expect(snapshot.issues[0]).toMatchObject({
            number: 65,
            projectItemId: 'project-item-65',
            projectStatus: 'Next',
        });
    });

    it('defaults to open issues and fails when a requested issue is absent', async () => {
        const issueCommand =
            'gh issue list --repo tjx666/caxri --state all --limit 1000 --json number,title,state,url,labels,updatedAt';
        const pullRequestCommand =
            'gh pr list --repo tjx666/caxri --state all --limit 1000 --json number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,updatedAt,closingIssuesReferences';
        const { runner } = fixtureRunner({
            [issueCommand]: issues,
            [pullRequestCommand]: pullRequests,
        });
        await expect(
            createIntakeSnapshot(
                {
                    cwd: '/repo',
                    fetch: false,
                    issueNumbers: [999],
                    projectNumber: 2,
                    repository: 'tjx666/caxri',
                },
                runner,
            ),
        ).rejects.toThrow('GitHub issues not found: 999');

        expect(parseIntakeSnapshotArguments([])).toMatchObject({
            fetch: true,
            issueNumbers: [],
            projectNumber: 2,
        });
        expect(() => parseIntakeSnapshotArguments(['--repo', 'invalid'])).toThrow(
            'OWNER/REPOSITORY',
        );
        expect(() => parseIntakeSnapshotArguments(['--repo'])).toThrow('Missing --repo value');
    });

    it('retries a transient read-only GitHub snapshot failure once', async () => {
        const issueCommand =
            'gh issue list --repo tjx666/caxri --state all --limit 1000 --json number,title,state,url,labels,updatedAt';
        const pullRequestCommand =
            'gh pr list --repo tjx666/caxri --state all --limit 1000 --json number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,updatedAt,closingIssuesReferences';
        const { calls, runner } = fixtureRunner({
            [issueCommand]: issues,
            [pullRequestCommand]: [new Error('GraphQL transport EOF'), pullRequests],
        });

        await expect(
            createIntakeSnapshot(
                {
                    cwd: '/repo',
                    fetch: false,
                    issueNumbers: [65],
                    projectNumber: 2,
                    repository: 'tjx666/caxri',
                },
                runner,
            ),
        ).resolves.toMatchObject({ authenticatedAs: 'builder' });
        expect(calls.filter((call) => call === pullRequestCommand)).toHaveLength(2);
    });
});
