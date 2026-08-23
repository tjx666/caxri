import type { ContributedCommandDescriptor, ViewCatalogSnapshot } from '@shared/views';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { useSessionViewStore } from '../../stores/session-view';
import { pushToast, tryCommand } from '../../stores/toasts';

function findViewCatalogCommand(
    catalog: ViewCatalogSnapshot | undefined,
    commandId: string,
): ContributedCommandDescriptor | undefined {
    return catalog?.commands.find(
        (command) => command.id === commandId && command.source.kind === 'extension',
    );
}

/**
 * Routes an extension command from every Renderer entry point. Container show commands stay local so a shortcut and the
 * Command Palette reveal the same surface, while extension-owned commands cross the typed Host boundary once.
 */
export function didExecuteViewCatalogCommand(
    catalog: ViewCatalogSnapshot | undefined,
    commandId: string,
    arguments_: readonly unknown[] = [],
): boolean {
    const command = findViewCatalogCommand(catalog, commandId);
    if (!command) return false;
    const container = catalog?.containers.find((candidate) => candidate.commandId === commandId);
    if (container?.location === 'secondarySidebar') {
        useChromeLayoutStore.getState().setSecondarySidebarVisible(true);
        useSessionViewStore.getState().setDesiredSecondarySidebarViewContainerId(container.id);
        return true;
    }
    if (container?.location === 'panel') {
        useChromeLayoutStore.getState().activatePanelViewContainer(container.id);
        return true;
    }
    // Fire-and-forget: tryCommand() owns the shared error path for Renderer command entry points.
    // eslint-disable-next-line no-void -- the command is dispatched exactly once and reports failures through a toast
    void tryCommand(`Unable to run ${command.title}`, () =>
        caxri.request('viewContainers.executeCommand', {
            commandId,
            arguments: [...arguments_],
        }),
    );
    return true;
}

/**
 * Resolves the Host catalog at shortcut time. `fetchQuery` reuses a fresh cache, reloads a missing/stale/invalidated
 * catalog, and therefore never turns an accepted extension keybinding into a cache-dependent silent no-op.
 */
export async function executeViewCatalogShortcut(
    commandId: string,
    arguments_: readonly unknown[] = [],
): Promise<void> {
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
