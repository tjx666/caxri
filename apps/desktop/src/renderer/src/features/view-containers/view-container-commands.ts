import type {
    ContributedCommandDescriptor,
    ExtensionCommandResult,
    TreeItemDto,
    ViewCatalogSnapshot,
} from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { getSelectedSession } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import type { ToastAction } from '../../stores/toast-actions';
import { describeFailure, isCancelledRequest, pushToast, tryCommand } from '../../stores/toasts';
import { revealSecondarySidebar } from '../secondary-sidebar/secondary-sidebar-visibility';
import { dispatchCoreViewCommand } from './core-view-commands';
import {
    currentViewEventContext,
    invalidateControlledViewSnapshotQueries,
} from './view-operation-client';

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
 *
 * This is the one place every Renderer entry point (palette, shortcut, toolbar, tree inline action) runs an extension
 * command, so it alone shows the command's `{ message }` result as the success toast. A tree action's declared
 * `feedback.success` is only the fallback for a command that resolved without one.
 */
export async function dispatchExtensionViewAction(
    commandId: string,
    commandTitle: string,
    arguments_: readonly unknown[] = [],
    feedback?: TreeItemActionFeedback,
): Promise<'executed' | 'failed'> {
    // Captured at the click, so a command still queued behind another repository mutation is cancelled rather than
    // started against a Session the user switched to meanwhile.
    const context = currentViewEventContext();
    const execute = () =>
        caxri.request('viewContainers.executeCommand', {
            commandId,
            arguments: [...arguments_],
            context,
        });
    if (!feedback) {
        const result = await tryCommand(
            translate('viewContainers.commands.runFailed', { title: commandTitle }),
            execute,
        );
        if (result === undefined) return 'failed';
        if (result.message) pushToast('success', result.message);
        return 'executed';
    }
    const action: ToastAction | undefined = feedback.githubUrl
        ? { id: 'github.open', params: { url: feedback.githubUrl } }
        : undefined;
    let result: ExtensionCommandResult;
    try {
        result = await execute();
    } catch (error) {
        if (!isCancelledRequest(error))
            pushToast(
                'error',
                actionFailureMessage(
                    error,
                    feedback.failure ??
                        translate('viewContainers.commands.runFailed', { title: commandTitle }),
                ),
                { action },
            );
        return 'failed';
    }
    const message = result.message ?? feedback.success;
    if (message) pushToast('success', message, { action });
    return 'executed';
}

type TreeItemActionFeedback = NonNullable<NonNullable<TreeItemDto['actions']>[number]['feedback']>;

/**
 * `Couldn't merge #42: <reason>`. The reason goes through the shared `describeFailure` sanitizer (path redaction,
 * error-code stripping); only its `label. reason` joint becomes a colon, because a provider's failure prefix names the
 * failed operation and the reason completes that sentence rather than starting a new one.
 */
export function actionFailureMessage(error: unknown, label: string): string {
    const described = describeFailure(error, label);
    const joint = `${label}. `;
    return described.startsWith(joint) ? `${label}: ${described.slice(joint.length)}` : described;
}

/**
 * Reactivates a failed extension. A rejected retry carries the Runtime's own code so the caller's toast can name the
 * reason rather than a generic failure.
 */
export async function retryExtension(extensionId: string): Promise<void> {
    const result = await caxri.request('extensions.retry', { extensionId });
    if (result.accepted || !result.error) return;
    throw Object.assign(new Error(result.error.message), { code: result.error.code });
}

/**
 * Reconciles command-owned provider state even when its one-shot change event raced the view's first subscription.
 */
export async function invalidateControlledViewSnapshot(viewId: string): Promise<void> {
    await invalidateControlledViewSnapshotQueries(queryClient, viewId);
}

function revealViewContainer(catalog: ViewCatalogSnapshot, containerId: string): void {
    const container = catalog.containers.find(({ id }) => id === containerId);
    if (container?.location === 'secondarySidebar') {
        revealSecondarySidebar();
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
 * Resolves the Server catalog at shortcut time. `query` reuses a fresh cache, reloads a missing/stale/invalidated
 * catalog, and therefore never turns an accepted extension keybinding into a cache-dependent silent no-op.
 */
export async function executeViewCatalogShortcut(
    commandId: string,
    arguments_: readonly unknown[] = [],
): Promise<void> {
    if (didRevealCachedViewContainerCommand(commandId)) return;
    const catalog = await tryCommand(translate('viewContainers.commands.loadFailed'), () =>
        queryClient.query({
            queryKey: caxriQueryKey('viewContainers.catalog', {}),
            queryFn: () => caxri.request('viewContainers.catalog', {}),
        }),
    );
    if (!catalog) return;
    if (!didExecuteViewCatalogCommand(catalog, commandId, arguments_))
        pushToast('error', translate('viewContainers.commands.unknown', { commandId }));
}

/**
 * Editable-focus shortcuts need an asynchronous manifest lookup when the catalog cache is cold. The event is consumed
 * by the caller before this check, and a command is dispatched only after the manifest explicitly grants the policy.
 */
export async function executeEditableViewCatalogShortcut(
    commandId: string,
    arguments_: readonly unknown[] = [],
): Promise<void> {
    const catalog = await tryCommand(translate('viewContainers.commands.loadFailed'), () =>
        queryClient.query({
            queryKey: caxriQueryKey('viewContainers.catalog', {}),
            queryFn: () => caxri.request('viewContainers.catalog', {}),
        }),
    );
    if (!catalog || !findViewCatalogCommand(catalog, commandId)?.allowInEditable) return;
    didExecuteViewCatalogCommand(catalog, commandId, arguments_);
}
