import { CancellationTokenSource } from 'caxri';
import { describe, expect, it } from 'vitest';

import type { ExtensionWorkspaceOperation } from '../../shared/extension-host-protocol';
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
    it('projects public Files calls onto the fixed workspace operation allowlist', async () => {
        const harness = requestHarness();
        const workspace = createWorkspaceApiClient(harness.request);

        await workspace.fs.create({
            operationId: 'operation-1',
            directory: '/project',
            name: 'file.ts',
            kind: 'file',
        });
        await workspace.fs.trash('/project/file.ts', { hasUnsavedChanges: true });
        await workspace.fs.reveal('/project/file.ts');

        expect(harness.calls).toEqual([
            [
                'files.create',
                {
                    operationId: 'operation-1',
                    directory: '/project',
                    name: 'file.ts',
                    kind: 'file',
                },
            ],
            ['files.trash', { path: '/project/file.ts', hasUnsavedChanges: true }],
            ['files.reveal', { path: '/project/file.ts' }],
        ]);
    });

    it('projects public Git calls without accepting a path, Session, or shell command', async () => {
        const harness = requestHarness();
        const workspace = createWorkspaceApiClient(harness.request);

        await workspace.git.sync('repository-1');
        await workspace.git.discard(
            { id: 'repository-1', name: 'project' },
            { kind: 'file', path: 'src/index.ts', untracked: false },
        );

        expect(harness.calls).toEqual([
            ['git.sync', { repositoryId: 'repository-1' }],
            [
                'git.discard',
                {
                    repositoryId: 'repository-1',
                    repositoryName: 'project',
                    scope: { kind: 'file', path: 'src/index.ts', untracked: false },
                },
            ],
        ]);
    });

    it('forwards the public cancellation token with Files and Git reads', async () => {
        const harness = requestHarness();
        const workspace = createWorkspaceApiClient(harness.request);
        const source = new CancellationTokenSource();

        await workspace.fs.list(undefined, source.token);
        await workspace.git.commits(
            { repositoryId: 'repository-1', offset: 0, pageSize: 10 },
            source.token,
        );

        expect(harness.tokens).toEqual([source.token, source.token]);
    });
});
