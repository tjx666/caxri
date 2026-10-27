import type { ViewBadge } from 'caxri';
import { EventEmitter } from 'caxri';
import { afterEach, describe, expect, it } from 'vitest';

import type { ExtensionHostMessage } from '../protocol';
import { withViewEventContext } from '../view-event-context';
import {
    createControlledViewRegistrationApi,
    didCancelViewRequest,
    executeViewOperation,
    retireViewProviders,
} from '../view-provider-service';

const viewId = 'fixture.view';
const context = {
    kind: 'session' as const,
    sessionId: 'session-a',
    workbenchRootProjectId: 'project-a',
};
const snapshot = (requestId = 'badge') =>
    executeViewOperation({
        extensionId: 'fixture',
        generation: 1,
        viewId,
        operation: 'badge.snapshot',
        arguments: {},
        requestId,
        context,
    });

function registration(isDeclared = true, messages: ExtensionHostMessage[] = []) {
    return createControlledViewRegistrationApi({
        extensionId: 'fixture',
        generation: 1,
        viewKinds: new Map([[viewId, 'source-control']]),
        badgeViewIds: new Set(isDeclared ? [viewId] : []),
        assertCurrent: () => {},
        send: (message) => messages.push(message),
    });
}

afterEach(() => retireViewProviders());

describe('view badge provider lifecycle', () => {
    it('rejects undeclared capabilities and permits independent content and badge registrations', async () => {
        expect(() =>
            registration(false).registerViewBadgeProvider(viewId, { provideBadge: () => {} }),
        ).toThrow('View badge is not declared');
        const api = registration();
        api.registerSourceControlProvider(viewId, {
            provideView: () => {
                throw new Error('Content must not load for a badge');
            },
            provideHistoryPage: () => {
                throw new Error('Unused');
            },
            provideHistoryDetails: () => {
                throw new Error('Unused');
            },
            runAction: () => {
                throw new Error('Unused');
            },
        });
        const badge = api.registerViewBadgeProvider(viewId, {
            provideBadge: ({ scopeId }) => ({ kind: 'count', count: 1, description: scopeId }),
        });
        expect(await snapshot()).toEqual({
            kind: 'count',
            count: 1,
            description: 'session-a:project-a',
        });
        badge.dispose();
        await expect(snapshot()).rejects.toMatchObject({ code: 'PROVIDER_MISSING' });
    });

    it('normalizes no badge to a serializable null', async () => {
        registration().registerViewBadgeProvider(viewId, { provideBadge: () => {} });
        expect(await snapshot()).toBeNull();
    });

    it.each(['cancel', 'retire'] as const)('rejects late results after %s', async (mode) => {
        const gate = Promise.withResolvers<ViewBadge>();
        registration().registerViewBadgeProvider(viewId, { provideBadge: () => gate.promise });
        const pending = snapshot();
        if (mode === 'cancel') didCancelViewRequest('badge');
        else retireViewProviders('fixture');
        gate.resolve({ kind: 'count', count: 1, description: '1 change' });
        await expect(pending).rejects.toMatchObject({
            code: mode === 'cancel' ? 'CANCELLED' : 'GENERATION_EXPIRED',
        });
    });

    it('emits only scoped events while its registration remains alive', () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- Exercise the extension API event subscription contract.
        const changed = new EventEmitter<void>();
        const messages: ExtensionHostMessage[] = [];
        const handle = registration(true, messages).registerViewBadgeProvider(viewId, {
            provideBadge: () => {},
            onDidChangeBadge: changed.event,
        });
        changed.fire();
        expect(messages).toEqual([]);
        withViewEventContext(context, () => changed.fire());
        expect(messages).toEqual([
            expect.objectContaining({ event: 'viewChanged', context, change: { kind: 'badge' } }),
        ]);
        handle.dispose();
        withViewEventContext(context, () => changed.fire());
        expect(messages).toHaveLength(1);
        changed.dispose();
    });
});
