import { CancellationTokenSource } from 'caxri';
import { describe, expect, it } from 'vitest';

import type { ExtensionWorkspaceOperation } from '../protocol';
import { createWorkspaceApiClient } from '../workspace-api-client';

function requestHarness() {
    const calls: Array<[ExtensionWorkspaceOperation, unknown]> = [];
    const tokens: unknown[] = [];
    return {
        calls,
        tokens,
        request: <Result>(
            operation: ExtensionWorkspaceOperation,
            arguments_: unknown,
            token?: unknown,
        ) => {
            calls.push([operation, arguments_]);
            tokens.push(token);
            return Promise.resolve(null as Result);
        },
    };
}

describe('Extension workspace API client', () => {
    it('projects public Git calls without accepting a path, Session, or shell command', async () => {
        const harness = requestHarness();
        const workspace = createWorkspaceApiClient(harness.request);

        await workspace.git.sync('repository-1');
        await workspace.git.discard('repository-1', {
            kind: 'file',
            path: 'src/index.ts',
        });
        await workspace.git.mergePullRequest('repository-1', {
            number: 42,
            headSha: 'a'.repeat(40),
        });

        expect(harness.calls).toEqual([
            ['git.sync', { repositoryId: 'repository-1' }],
            [
                'git.discard',
                {
                    repositoryId: 'repository-1',
                    scope: { kind: 'file', path: 'src/index.ts' },
                },
            ],
            [
                'git.mergePullRequest',
                { repositoryId: 'repository-1', number: 42, headSha: 'a'.repeat(40) },
            ],
        ]);
    });

    it('forwards the public cancellation token with Git reads', async () => {
        const harness = requestHarness();
        const workspace = createWorkspaceApiClient(harness.request);
        const source = new CancellationTokenSource();

        await workspace.git.commits(
            { repositoryId: 'repository-1', offset: 0, pageSize: 10 },
            source.token,
        );

        expect(harness.tokens).toEqual([source.token]);
    });
});
