// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { Principal, ProjectStatusRepository } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import {
    mergeMobilePullRequest,
    projectMobilePullRequest,
    readMobilePullRequest,
} from '../pull-request-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';

const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-1'],
};

const HEAD = 'a'.repeat(40);

type PullRequest = NonNullable<ProjectStatusRepository['pullRequest']>;

function repo(
    id: string,
    kind: ProjectStatusRepository['kind'],
    pullRequest?: Partial<PullRequest>,
): ProjectStatusRepository {
    return {
        id,
        kind,
        name: id,
        rootPath: `/projects/${id}`,
        branch: 'feat/merge',
        linearIssues: [],
        acceptances: [],
        errors: [],
        ...(pullRequest && {
            pullRequest: {
                number: 42,
                title: 'Delivery',
                url: 'https://github.com/acme/widget/pull/42',
                lifecycle: 'open',
                state: 'success',
                checks: [],
                hiddenCheckCount: 0,
                headSha: HEAD,
                mergeState: 'clean',
                ...pullRequest,
            },
        }),
    };
}

function domainFixture(repositories: ProjectStatusRepository[]) {
    const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(
        async (method) => {
            if (method === 'session.queryForPrincipal') return { sessions: [{ id: 'session-1' }] };
            if (method === 'projectStatus.summary') return { repositories };
            throw new Error(`Unexpected ${method}`);
        },
    );
    const requestWithSignal = vi.fn(async () => ({
        method: 'squash',
        url: 'https://github.com/acme/widget/pull/42',
    }));
    return {
        domainService: { request, requestWithSignal } as unknown as ServerDomainService,
        request,
        requestWithSignal,
    };
}

const merge = (number = 42) =>
    ({
        method: 'mobile.pullRequest.merge',
        params: { sessionId: 'session-1', repositoryId: 'primary', number, headSha: HEAD },
    }) as const;

describe('mobile pull request requests', () => {
    it("shows the primary repository's pull request with the same merge blocker Desktop reads", async () => {
        const domain = domainFixture([
            repo('nested', 'nested', { number: 7 }),
            repo('primary', 'primary', {
                state: 'failure',
                mergeBlocker: 'checks-failed',
                checks: ['lint', 'unit', 'e2e', 'docs', 'types'].map((name) => ({
                    name,
                    state: name === 'unit' ? 'success' : 'failure',
                })),
            }),
        ]);
        const result = await readMobilePullRequest(domain.domainService, principal, {
            method: 'mobile.pullRequest.read',
            params: { sessionId: 'session-1' },
        });
        expect(domain.request).toHaveBeenCalledWith('session.queryForPrincipal', {
            principal,
            query: { mode: 'show', selector: 'session-1' },
        });
        expect(result.pullRequest).toEqual({
            repositoryId: 'primary',
            number: 42,
            title: 'Delivery',
            url: 'https://github.com/acme/widget/pull/42',
            lifecycle: 'open',
            checks: 'failure',
            checkCount: 5,
            failedChecks: ['lint', 'e2e', 'docs'],
            failedCheckCount: 4,
            headSha: HEAD,
            mergeBlocker: 'checks-failed',
        });
    });

    it("falls back to another repository's pull request and reports none when no repository has one", () => {
        expect(
            projectMobilePullRequest([
                repo('primary', 'primary'),
                repo('worktree', 'worktree', { number: 9 }),
            ]),
        ).toMatchObject({ repositoryId: 'worktree', number: 9 });
        expect(projectMobilePullRequest([repo('primary', 'primary')])).toBeUndefined();
    });

    it("merges through Desktop's git.mergePullRequest pinned to the head the phone showed", async () => {
        const domain = domainFixture([repo('primary', 'primary', {})]);
        const signal = new AbortController().signal;
        await expect(
            mergeMobilePullRequest(domain.domainService, principal, merge(), signal),
        ).resolves.toEqual({ method: 'squash' });
        expect(domain.requestWithSignal).toHaveBeenCalledWith(
            'git.mergePullRequest',
            { sessionId: 'session-1', repositoryId: 'primary', number: 42, headSha: HEAD },
            signal,
        );
    });

    it('refuses a conflict or a pull request the Session no longer delivers without asking GitHub', async () => {
        const conflicting = domainFixture([
            repo('primary', 'primary', {
                mergeState: 'conflicting',
                mergeBlocker: 'conflicting',
            }),
        ]);
        const signal = new AbortController().signal;
        await expect(
            mergeMobilePullRequest(conflicting.domainService, principal, merge(), signal),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(
            mergeMobilePullRequest(conflicting.domainService, principal, merge(43), signal),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(conflicting.requestWithSignal).not.toHaveBeenCalled();
    });

    it('lets every role read the pull request and only a control device merge it', () => {
        for (const role of ['view', 'reply', 'control'] as const)
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.pullRequest.read')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.pullRequest.merge')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.pullRequest.merge')).toBe(
            false,
        );
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.pullRequest.merge')).toBe(
            true,
        );
    });
});
