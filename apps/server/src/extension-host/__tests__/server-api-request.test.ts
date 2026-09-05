import { runWithObservationContext } from '@caxri/system';
import { CancellationTokenSource } from 'caxri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProviderRequestScope, withProviderRequestScope } from '../extension-error';
import type { ExtensionHostMessage } from '../protocol';
import { rejectPendingApiRequests, requestServerApi, settleApiReply } from '../server-api-request';

const context = {
    kind: 'session' as const,
    sessionId: 'session-1',
    workbenchProjectId: 'project-1',
};

describe('Extension Host API requests', () => {
    afterEach(() => {
        rejectPendingApiRequests('Test cleanup');
        vi.useRealTimers();
    });

    it('reports public-token cancellation as a typed non-fault outcome', async () => {
        const sent: ExtensionHostMessage[] = [];
        const source = new CancellationTokenSource();
        const request = requestServerApi(
            {
                apiToken: 'token-1',
                extensionId: 'publisher.fixture',
                generation: 1,
                assertCurrent: () => {},
                isApiTokenCurrent: () => true,
                send: (message) => sent.push(message),
            },
            {
                method: 'workspace.request',
                params: { operation: 'git.summary', arguments: { refresh: 0 }, context },
            },
            source.token,
        );

        source.cancel();

        await expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(sent).toContainEqual(expect.objectContaining({ type: 'api-cancel' }));
    });

    it('waits for the authoritative reply after cancelling a non-expiring mutation', async () => {
        vi.useFakeTimers();
        const sent: ExtensionHostMessage[] = [];
        const source = new CancellationTokenSource();
        const request = requestServerApi(
            {
                apiToken: 'token-1',
                extensionId: 'publisher.fixture',
                generation: 1,
                assertCurrent: () => {},
                isApiTokenCurrent: () => true,
                send: (message) => sent.push(message),
            },
            {
                method: 'workspace.request',
                params: {
                    operation: 'git.sync',
                    arguments: { repositoryId: 'repository-1' },
                    context,
                },
            },
            source.token,
        );
        let isSettled = false;
        const observed = (async () => {
            try {
                return await request;
            } finally {
                isSettled = true;
            }
        })();

        await vi.advanceTimersByTimeAsync(15_000);

        expect(isSettled).toBe(false);
        expect(sent).not.toContainEqual(expect.objectContaining({ type: 'api-cancel' }));
        source.cancel();
        expect(sent).toContainEqual(expect.objectContaining({ type: 'api-cancel' }));
        expect(isSettled).toBe(false);
        const apiRequest = sent.find((message) => message.type === 'api-request');
        if (!apiRequest) throw new Error('Request not sent');
        settleApiReply({ id: apiRequest.id, ok: true, result: null }, () => true);
        await expect(observed).resolves.toBeNull();
    });

    it('still reports cancellation when Host stops a non-expiring mutation before its boundary', async () => {
        const sent: ExtensionHostMessage[] = [];
        const source = new CancellationTokenSource();
        const request = requestServerApi(
            {
                apiToken: 'token-1',
                extensionId: 'publisher.fixture',
                generation: 1,
                assertCurrent: () => {},
                isApiTokenCurrent: () => true,
                send: (message) => sent.push(message),
            },
            {
                method: 'workspace.request',
                params: {
                    operation: 'git.discard',
                    arguments: { repositoryId: 'repository-1', scope: { kind: 'all' } },
                    context,
                },
            },
            source.token,
        );

        source.cancel();
        const apiRequest = sent.find((message) => message.type === 'api-request');
        if (!apiRequest) throw new Error('Request not sent');
        settleApiReply(
            {
                id: apiRequest.id,
                ok: false,
                error: { code: 'CANCELLED', message: 'Operation cancelled' },
            },
            () => true,
        );

        await expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('cancels Host work when an expiring API request times out', async () => {
        vi.useFakeTimers();
        const sent: ExtensionHostMessage[] = [];
        const request = requestServerApi(
            {
                apiToken: 'token-1',
                extensionId: 'publisher.fixture',
                generation: 1,
                assertCurrent: () => {},
                isApiTokenCurrent: () => true,
                send: (message) => sent.push(message),
            },
            {
                method: 'workspace.request',
                params: { operation: 'git.summary', arguments: { refresh: 0 }, context },
            },
        );

        const assertion = expect(request).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(15_000);

        await assertion;
        expect(sent).toContainEqual(expect.objectContaining({ type: 'api-cancel' }));
    });

    it('forwards normalized root correlation with a private operation id', async () => {
        const sent: ExtensionHostMessage[] = [];
        const request = runWithObservationContext(
            {
                operationId: 'extension-operation',
                requestId: 'control-request',
                sessionId: 'session-1',
                traceId: 'control-trace',
            },
            () =>
                requestServerApi(
                    {
                        apiToken: 'token-1',
                        extensionId: 'publisher.fixture',
                        generation: 1,
                        assertCurrent: () => {},
                        isApiTokenCurrent: () => true,
                        send: (message) => sent.push(message),
                    },
                    {
                        method: 'workspace.request',
                        params: {
                            operation: 'git.summary',
                            arguments: { repositoryId: '/private/project', secret: 'do-not-log' },
                            context,
                        },
                    },
                ),
        );
        const apiRequest = sent.find((message) => message.type === 'api-request');
        if (!apiRequest) throw new Error('Request not sent');

        expect(apiRequest.observation).toEqual({
            operationId: apiRequest.id,
            requestId: 'control-request',
            sessionId: 'session-1',
            traceId: 'control-trace',
        });
        expect(JSON.stringify(apiRequest.observation)).not.toContain('/private/project');
        expect(JSON.stringify(apiRequest.observation)).not.toContain('do-not-log');
        settleApiReply({ id: apiRequest.id, ok: true, result: null }, () => true);
        await expect(request).resolves.toBeNull();
    });
});

describe('provider request scope attribution', () => {
    const apiContext = {
        apiToken: 'token-1',
        extensionId: 'publisher.fixture',
        generation: 1,
        assertCurrent: () => {},
        isApiTokenCurrent: () => true,
    };
    const summary = {
        method: 'workspace.request' as const,
        params: { operation: 'git.summary' as const, arguments: { refresh: 0 }, context },
    };

    async function settled(request: Promise<unknown>): Promise<unknown> {
        try {
            await request;
        } catch (error: unknown) {
            return error;
        }
        throw new Error('expected the request to reject');
    }

    it("marks the issuing request when Server Core's reply expires the call", async () => {
        const sent: ExtensionHostMessage[] = [];
        const scope = createProviderRequestScope();
        const request = withProviderRequestScope(scope, () =>
            requestServerApi({ ...apiContext, send: (message) => sent.push(message) }, summary),
        );
        const issued = sent.find((message) => message.type === 'api-request');
        expect(issued).toBeDefined();

        settleApiReply(
            {
                id: issued!.id,
                ok: false,
                error: {
                    code: 'GENERATION_EXPIRED',
                    message: 'Active Project changed while the extension request was running',
                },
            },
            () => true,
        );

        await expect(settled(request)).resolves.toMatchObject({ code: 'GENERATION_EXPIRED' });
        expect(scope.hostExpiredApiCall).toBe(true);
    });

    it('marks the issuing request when the Extension Host generation is reconfigured', async () => {
        const scope = createProviderRequestScope();
        const request = withProviderRequestScope(scope, () =>
            requestServerApi({ ...apiContext, send: () => {} }, summary),
        );

        rejectPendingApiRequests('Extension generation was reconfigured');

        await expect(settled(request)).resolves.toMatchObject({ code: 'GENERATION_EXPIRED' });
        expect(scope.hostExpiredApiCall).toBe(true);
    });

    it('does not let a token cancellation or a Server Core fault mark the request', async () => {
        const sent: ExtensionHostMessage[] = [];
        const scope = createProviderRequestScope();
        const source = new CancellationTokenSource();
        const cancelled = withProviderRequestScope(scope, () =>
            requestServerApi(
                { ...apiContext, send: (message) => sent.push(message) },
                summary,
                source.token,
            ),
        );
        // The token may be the extension's own, so its cancellation is not the host's decision.
        source.cancel();
        await expect(settled(cancelled)).resolves.toMatchObject({ code: 'CANCELLED' });

        const failed = withProviderRequestScope(scope, () =>
            requestServerApi({ ...apiContext, send: (message) => sent.push(message) }, summary),
        );
        const issued = sent.findLast((message) => message.type === 'api-request');
        settleApiReply(
            { id: issued!.id, ok: false, error: { code: 'GIT_FAILED', message: 'git exited 128' } },
            () => true,
        );
        await expect(settled(failed)).resolves.toMatchObject({ code: 'GIT_FAILED' });

        expect(scope.hostExpiredApiCall).toBe(false);
    });
});
