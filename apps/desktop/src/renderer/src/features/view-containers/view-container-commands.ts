import type { ContributedCommandDescriptor, ViewCatalogSnapshot } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { getSelectedSession } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { pushToast, tryCommand } from '../../stores/toasts';
import { dispatchCoreViewCommand } from './core-view-commands';
import { isControlledViewOperationQuery } from './view-operation-client';

function findViewCatalogCommand(
    catalog: ViewCatalogSnapshot | undefined,
    commandId: string,
): ContributedCommandDescriptor | undefined {
    return catalog?.commands.find(
        (command) => command.id === commandId && command.source.kind !== 'builtin',
    );
}

export function isCachedViewCatalogCommandAllowedInEditable(commandId: string): boolean {
    return getCachedViewCatalogCommandAllowedInEditable(commandId) ?? false;
}

/**
 * Returns `undefined` only when the manifest catalog is not cached yet. A cached catalog that does not opt a command
 * into editable focus is an explicit denial and must not trigger an asynchronous dispatch.
 */
export function getCachedViewCatalogCommandAllowedInEditable(
    commandId: string,
): boolean | undefined {
    const catalog = queryClient.getQueryData<ViewCatalogSnapshot>(
        caxriQueryKey('viewContainers.catalog', {}),
    );
    if (!catalog) return undefined;
    return findViewCatalogCommand(catalog, commandId)?.allowInEditable ?? false;
}

/**
 * Dispatches one extension-contributed view action and keeps its promise observable by an in-place control. Palette and
 * shortcut entry points intentionally remain fire-and-forget, while a toolbar button needs the completion signal to
 * suppress repeated activation until its provider refresh starts.
 */
export async function dispatchExtensionViewAction(
    commandId: string,
    commandTitle: string,
    arguments_: readonly unknown[] = [],
): Promise<'executed' | 'failed'> {
    const result = await tryCommand(`Unable to run ${commandTitle}`, () =>
        caxri.request('viewContainers.executeCommand', {
            commandId,
            arguments: [...arguments_],
        }),
    );
    return result === undefined ? 'failed' : 'executed';
}

/**
 * Reconciles command-owned provider state even when its one-shot change event raced the view's first subscription.
 */
export async function invalidateControlledViewSnapshot(viewId: string): Promise<void> {
    await queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
            isControlledViewOperationQuery(queryKey, viewId, 'source.snapshot'),
    });
}

function revealViewContainer(catalog: ViewCatalogSnapshot, containerId: string): void {
    const container = catalog.containers.find(({ id }) => id === containerId);
    if (container?.location === 'secondarySidebar') {
        useChromeLayoutStore.getState().setSecondarySidebarVisible(true);
        useSessionViewStore.getState().setDesiredSecondarySidebarViewContainerId(container.id);
    } else if (container?.location === 'panel')
        useChromeLayoutStore.getState().activatePanelViewContainer(container.id);
}

/**
 * Reveals an already rendered container synchronously. Catalog invalidation may leave a Server reload pending, but a
 * show command only selects local UI that the cached catalog still renders; making that selection wait on IPC causes
 * unrelated catalog refreshes to swallow otherwise valid keyboard shortcuts. Extension actions continue through the
 * refreshed catalog path below, so this fast path never executes provider code or relaxes command permissions.
 */
function didRevealCachedViewContainerCommand(commandId: string): boolean {
    const catalog = queryClient.getQueryData<ViewCatalogSnapshot>(
        caxriQueryKey('viewContainers.catalog', {}),
    );
    if (!catalog || !findViewCatalogCommand(catalog, commandId)) return false;
    const container = catalog.containers.find((candidate) => candidate.commandId === commandId);
    if (!container) return false;
    revealViewContainer(catalog, container.id);
    return true;
}

/**
 * Routes a catalog command from every Renderer entry point. Container show commands stay local, Workbench Core actions
 * enter the generic controlled-surface queue, and extension-owned commands cross the typed Server boundary once.
 */
export function didExecuteViewCatalogCommand(
    catalog: ViewCatalogSnapshot | undefined,
    commandId: string,
    arguments_: readonly unknown[] = [],
): boolean {
    const command = findViewCatalogCommand(catalog, commandId);
    if (!command) return false;
    const container = catalog?.containers.find((candidate) => candidate.commandId === commandId);
    if (container) {
        revealViewContainer(catalog!, container.id);
        return true;
    }
    const owningView = catalog?.views.find((view) =>
        view.actions?.some((action) => action.commandId === commandId),
    );
    if (owningView) revealViewContainer(catalog!, owningView.containerId);
    const action = owningView?.actions?.find((candidate) => candidate.commandId === commandId);
    if (owningView && action && command.source.kind === 'core') {
        const session = getSelectedSession();
        if (!session) return true;
        dispatchCoreViewCommand({
            arguments: arguments_,
            commandId,
            contextKey: `${session.id}:${session.workbenchProjectId}`,
            role: action.role,
            viewId: owningView.id,
        });
        return true;
    }
    // Fire-and-forget: dispatchExtensionViewAction() owns the shared error path for Renderer command entry points.
    // eslint-disable-next-line no-void -- the command is dispatched exactly once and reports failures through a toast
    void dispatchExtensionViewAction(commandId, command.title, arguments_);
    return true;
}

/**
 * Resolves the Server catalog at shortcut time. `fetchQuery` reuses a fresh cache, reloads a missing/stale/invalidated
 * catalog, and therefore never turns an accepted extension keybinding into a cache-dependent silent no-op.
 */
export async function executeViewCatalogShortcut(
    commandId: string,
    arguments_: readonly unknown[] = [],
): Promise<void> {
    if (didRevealCachedViewContainerCommand(commandId)) return;
    const catalog = await tryCommand('Unable to load extension commands', () =>
        queryClient.fetchQuery({
            queryKey: caxriQueryKey('viewContainers.catalog', {}),
            queryFn: () => caxri.request('viewContainers.catalog', {}),
        }),
    );
    if (!catalog) return;
    if (!didExecuteViewCatalogCommand(catalog, commandId, arguments_))
        pushToast('error', `Unknown command: ${commandId}`);
}

/**
 * Editable-focus shortcuts need an asynchronous manifest lookup when the catalog cache is cold. The event is consumed
 * by the caller before this check, and a command is dispatched only after the manifest explicitly grants the policy.
 */
export async function executeEditableViewCatalogShortcut(
    commandId: string,
    arguments_: readonly unknown[] = [],
): Promise<void> {
    const catalog = await tryCommand('Unable to load extension commands', () =>
        queryClient.fetchQuery({
            queryKey: caxriQueryKey('viewContainers.catalog', {}),
            queryFn: () => caxri.request('viewContainers.catalog', {}),
        }),
    );
    if (!catalog || !findViewCatalogCommand(catalog, commandId)?.allowInEditable) return;
    didExecuteViewCatalogCommand(catalog, commandId, arguments_);
}
