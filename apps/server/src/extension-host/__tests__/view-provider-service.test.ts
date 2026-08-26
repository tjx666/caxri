import type { SourceControlProvider, SourceControlViewModel } from 'caxri';
import { EventEmitter } from 'caxri';
import { afterEach, describe, expect, it } from 'vitest';

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
