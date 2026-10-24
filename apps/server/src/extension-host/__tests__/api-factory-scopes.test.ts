import { EventEmitter, TreeItem, TreeItemCollapsibleState } from 'caxri';
import { describe, expect, it } from 'vitest';

import { configureExtensions, extensionApiBinding, getTreeChildren } from '../api-factory';
import type { ExtensionViewEventScope } from '../protocol';
import { withViewEventContext } from '../view-event-context';
import { installExtensionFixture, registration } from './api-factory.fixture';

installExtensionFixture();

const sessionA: ExtensionViewEventScope = {
    kind: 'session',
    sessionId: 'session-a',
    workbenchProjectId: 'project-1',
};
const sessionB: ExtensionViewEventScope = {
    kind: 'session',
    sessionId: 'session-b',
    workbenchProjectId: 'project-1',
};

function readTree(context: ExtensionViewEventScope, parentHandle?: string) {
    return getTreeChildren({
        extensionId: 'publisher.fixture',
        generation: 1,
        viewId: 'publisher.fixture.tree',
        requestId: `scoped-${crypto.randomUUID()}`,
        context,
        ...(parentHandle && { parentHandle }),
    });
}

/**
 * Two windows or a phone read one tree view for different Sessions at once, so the Host keeps one handle space per
 * Session scope. A shared space let one Session's read replace the other's handles or reject its TreeItem ids.
 */
describe('Extension Host tree scopes', () => {
    it('serves the same TreeItem ids to two Sessions without cross-scope collisions', async () => {
        configureExtensions([registration()]);
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: (element: string | undefined) =>
                    element ? [`${element}-child`] : ['root'],
                getTreeItem: (element: string) => {
                    const item = new TreeItem(element, TreeItemCollapsibleState.Collapsed);
                    item.id = element;
                    return item;
                },
            },
        );

        const rootA = await readTree(sessionA);
        const rootB = await readTree(sessionB);
        expect(rootA.items[0].handle).toBe(rootB.items[0].handle);

        await expect(readTree(sessionA, rootA.items[0].handle)).resolves.toEqual({
            items: [expect.objectContaining({ label: 'root-child' })],
        });
        await expect(readTree(sessionB, rootB.items[0].handle)).resolves.toEqual({
            items: [expect.objectContaining({ label: 'root-child' })],
        });
    });

    it('rejects a parent handle minted for another Session', async () => {
        configureExtensions([registration()]);
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: (element: { label: string } | undefined) =>
                    element ? [{ label: 'child' }] : [{ label: 'root' }],
                getTreeItem: (element: { label: string }) =>
                    new TreeItem(element.label, TreeItemCollapsibleState.Collapsed),
            },
        );

        const rootA = await readTree(sessionA);

        await expect(readTree(sessionB, rootA.items[0].handle)).rejects.toMatchObject({
            code: 'GENERATION_EXPIRED',
        });
    });

    it('evicts the least recently read Session scope beyond the per-view bound', async () => {
        configureExtensions([registration()]);
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: (element: { label: string } | undefined) =>
                    element ? [{ label: 'child' }] : [{ label: 'root' }],
                getTreeItem: (element: { label: string }) =>
                    new TreeItem(element.label, TreeItemCollapsibleState.Collapsed),
            },
        );

        const rootA = await readTree(sessionA);
        const rootB = await readTree(sessionB);
        for (let index = 0; index < 63; index += 1)
            // eslint-disable-next-line no-await-in-loop -- Scopes must be read in order to fix their recency.
            await readTree({
                kind: 'session',
                sessionId: `filler-${index}`,
                workbenchProjectId: 'project-1',
            });

        // Read B first: re-reading the evicted A creates a fresh scope, which evicts the next oldest one.
        await expect(readTree(sessionB, rootB.items[0].handle)).resolves.toEqual({
            items: [expect.objectContaining({ label: 'child' })],
        });
        await expect(readTree(sessionA, rootA.items[0].handle)).rejects.toMatchObject({
            code: 'GENERATION_EXPIRED',
        });
    });

    it('retires only the refreshed Session handles and keeps a delayed read in its own scope', async () => {
        configureExtensions([registration()]);
        // eslint-disable-next-line unicorn/prefer-event-target -- Verify the public VS Code-compatible provider event.
        const changes = new EventEmitter<undefined>();
        const delayedRootA = Promise.withResolvers<ReadonlyArray<{ label: string }>>();
        let shouldDelayA = false;
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                onDidChangeTreeData: changes.event,
                getChildren: (element: { label: string } | undefined) => {
                    if (element) return [{ label: `child-of-${element.label}` }];
                    const scopeId =
                        extensionApiBinding('fixture-token-1').api.workspace.getCurrentContext()
                            ?.scopeId;
                    if (scopeId === 'session-a:project-1' && shouldDelayA)
                        return delayedRootA.promise;
                    return [{ label: scopeId ?? 'none' }];
                },
                getTreeItem: (element: { label: string }) =>
                    new TreeItem(element.label, TreeItemCollapsibleState.Collapsed),
            },
        );

        const rootA = await readTree(sessionA);
        const rootB = await readTree(sessionB);
        withViewEventContext(sessionA, () => changes.fire(undefined));

        await expect(readTree(sessionA, rootA.items[0].handle)).rejects.toMatchObject({
            code: 'GENERATION_EXPIRED',
        });
        await expect(readTree(sessionB, rootB.items[0].handle)).resolves.toEqual({
            items: [expect.objectContaining({ label: 'child-of-session-b:project-1' })],
        });

        shouldDelayA = true;
        const pendingA = readTree(sessionA);
        const freshB = await readTree(sessionB);
        delayedRootA.resolve([{ label: 'late-a' }]);
        const freshA = await pendingA;

        expect(freshA.items[0].label).toBe('late-a');
        expect(freshB.items[0].label).toBe('session-b:project-1');
        await expect(readTree(sessionA, freshA.items[0].handle)).resolves.toEqual({
            items: [expect.objectContaining({ label: 'child-of-late-a' })],
        });
        await expect(readTree(sessionB, freshB.items[0].handle)).resolves.toEqual({
            items: [expect.objectContaining({ label: 'child-of-session-b:project-1' })],
        });
    });
});
