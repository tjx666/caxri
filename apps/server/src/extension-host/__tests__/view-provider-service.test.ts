import type { SourceControlProvider, SourceControlViewModel } from 'caxri';
import { EventEmitter } from 'caxri';
import { afterEach, describe, expect, it } from 'vitest';

import { hostError, isHostOriginatedError } from '../extension-error';
import type { ExtensionHostMessage } from '../protocol';
import {
    createControlledViewRegistrationApi,
    didCancelViewRequest,
    executeViewOperation,
    retireViewProviders,
} from '../view-provider-service';

const model: SourceControlViewModel = {
    revision: '1',
    title: 'Provider View',
    accessibilityLabel: 'Provider resources',
    modeAccessibilityLabel: 'Provider mode',
    modes: [
        {
            id: 'primary',
            label: 'Primary',
            icon: { kind: 'theme', id: 'list' },
            command: { id: 'publisher.fixture.primary' },
        },
    ],
    selectedModeId: 'primary',
    refreshAction: {
        id: 'refresh-1',
        label: 'Refresh',
        icon: { kind: 'theme', id: 'refresh' },
        command: { id: 'publisher.fixture.refresh' },
    },
    providers: [],
};

afterEach(() => retireViewProviders());

describe('controlled view provider runtime', () => {
    function registerSnapshotProvider(provideView: SourceControlProvider['provideView']): void {
        createControlledViewRegistrationApi({
            extensionId: 'publisher.fixture',
            generation: 3,
            viewKinds: new Map([['publisher.fixture.sourceControl', 'source-control']]),
            assertCurrent: () => {},
            send: () => {},
        }).registerSourceControlProvider('publisher.fixture.sourceControl', {
            provideView,
            provideHistoryPage: () => ({ items: [], revision: '1' }),
            provideHistoryDetails: () => ({
                additions: 0,
                deletions: 0,
                itemId: 'item-1',
                resources: [],
                revision: '1',
                summary: '0 files changed',
                truncated: false,
            }),
            runAction: () => ({ effects: [], refresh: false, revision: '1' }),
        });
    }

    async function rejectionOf(request: Promise<unknown>): Promise<unknown> {
        try {
            await request;
        } catch (error: unknown) {
            return error;
        }
        throw new Error('expected the request to reject');
    }

    function snapshot(requestId: string): Promise<unknown> {
        return executeViewOperation({
            extensionId: 'publisher.fixture',
            generation: 3,
            viewId: 'publisher.fixture.sourceControl',
            operation: 'source.snapshot',
            arguments: { refresh: 0 },
            requestId,
        });
    }

    it("re-mints a provider's own CANCELLED as host-originated once the host cancelled the request", async () => {
        // Mirrors extensions/git/src/git-provider.ts: after awaiting Git, the provider throws its own plain
        // CANCELLED when the token it was given is cancelled. That is the host's decision reported back (#587), so it
        // must stay a debug non-fault even though the object was never minted through `hostError` (#606).
        const gate = Promise.withResolvers<void>();
        registerSnapshotProvider(async (_request, token) => {
            await gate.promise;
            if (token.isCancellationRequested)
                throw Object.assign(new Error('Source Control request was cancelled'), {
                    code: 'CANCELLED',
                });
            return model;
        });
        const request = snapshot('snapshot-cancelled');
        expect(didCancelViewRequest('snapshot-cancelled')).toBe(true);
        gate.resolve();

        const rejection = await rejectionOf(request);
        expect(rejection).toMatchObject({
            code: 'CANCELLED',
            message: 'Source Control request was cancelled',
        });
        expect(isHostOriginatedError(rejection)).toBe(true);
    });

    it('keeps a provider-thrown CANCELLED a fault while the host never cancelled the request', async () => {
        registerSnapshotProvider(() => {
            throw Object.assign(new Error('boom'), { code: 'CANCELLED' });
        });

        const rejection = await rejectionOf(snapshot('snapshot-forged'));
        expect(rejection).toMatchObject({ code: 'CANCELLED', message: 'boom' });
        expect(isHostOriginatedError(rejection)).toBe(false);
    });

    it('strips host origin from a host-minted error a provider re-throws with current host state', async () => {
        // An extension can capture a rejection it received from a `caxri.*` API call and throw it from its provider.
        const captured = hostError('GENERATION_EXPIRED', 'Extension API binding has expired');
        registerSnapshotProvider(() => {
            throw captured;
        });

        const rejection = await rejectionOf(snapshot('snapshot-replayed'));
        expect(rejection).not.toBe(captured);
        expect(rejection).toMatchObject({ code: 'GENERATION_EXPIRED' });
        expect(isHostOriginatedError(rejection)).toBe(false);
    });

    it('preserves an authoritative action result after cancellation reaches its provider', async () => {
        const action = Promise.withResolvers<{
            effects: [];
            refresh: boolean;
            revision: string;
        }>();
        const provider: SourceControlProvider = {
            provideView: () => model,
            provideHistoryPage: () => ({ items: [], revision: '1' }),
            provideHistoryDetails: () => ({
                additions: 0,
                deletions: 0,
                itemId: 'item-1',
                resources: [],
                revision: '1',
                summary: '0 files changed',
                truncated: false,
            }),
            runAction: () => action.promise,
        };
        createControlledViewRegistrationApi({
            extensionId: 'publisher.fixture',
            generation: 3,
            viewKinds: new Map([['publisher.fixture.sourceControl', 'source-control']]),
            assertCurrent: () => {},
            send: () => {},
        }).registerSourceControlProvider('publisher.fixture.sourceControl', provider);
        const request = executeViewOperation({
            extensionId: 'publisher.fixture',
            generation: 3,
            viewId: 'publisher.fixture.sourceControl',
            operation: 'source.action',
            arguments: { actionId: 'action-1', revision: '1' },
            requestId: 'action-request-1',
        });

        expect(didCancelViewRequest('action-request-1')).toBe(true);
        action.resolve({ effects: [], refresh: true, revision: '1' });

        await expect(request).resolves.toEqual({ effects: [], refresh: true, revision: '1' });
    });

    it('retains request scope for a provider-owned background content event', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- The public provider API intentionally mirrors VS Code events.
        const changes = new EventEmitter<{ kind: 'content' | 'refresh' }>();
        const sent: ExtensionHostMessage[] = [];
        let receivedScopeId: string | undefined;
        const provider: SourceControlProvider = {
            onDidChange: changes.event,
            provideView: (request) => {
                receivedScopeId = request.scopeId;
                setTimeout(() => changes.fire({ kind: 'content' }), 0);
                return model;
            },
            provideHistoryPage: () => ({ items: [], revision: '1' }),
            provideHistoryDetails: () => ({
                additions: 0,
                deletions: 0,
                itemId: 'item-1',
                resources: [],
                revision: '1',
                summary: '0 files changed',
                truncated: false,
            }),
            runAction: () => ({ effects: [], refresh: false, revision: '1' }),
        };
        const api = createControlledViewRegistrationApi({
            extensionId: 'publisher.fixture',
            generation: 3,
            viewKinds: new Map([['publisher.fixture.sourceControl', 'source-control']]),
            assertCurrent: () => {},
            send: (message) => sent.push(message),
        });
        api.registerSourceControlProvider('publisher.fixture.sourceControl', provider);
        const context = {
            kind: 'session' as const,
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        };

        await executeViewOperation({
            extensionId: 'publisher.fixture',
            generation: 3,
            viewId: 'publisher.fixture.sourceControl',
            operation: 'source.snapshot',
            arguments: { refresh: 0 },
            requestId: 'snapshot-1',
            context,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(sent).toContainEqual(
            expect.objectContaining({
                type: 'event',
                event: 'viewChanged',
                context,
                change: { kind: 'content' },
            }),
        );
        expect(receivedScopeId).toBe('session-1:project-1');

        changes.dispose();
    });
});
