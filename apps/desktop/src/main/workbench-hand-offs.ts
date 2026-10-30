import type { CommandId, ServerEvent } from '@caxri/protocol';

import type { DesktopServerConnection } from './connection/server-connection';
import type { MainMethodHandlerOptions } from './main-methods';
import { PRIMARY_WINDOW_KEY } from './window-presence-registry';

/**
 * Runs a command in the Workbench Renderer, which owns every command-backed menu item.
 */
export function workbenchCommandDispatcher(
    sendEvent: (event: ServerEvent) => void,
): (command: CommandId, isViaAccelerator: boolean) => void {
    return (command, isViaAccelerator) =>
        sendEvent({
            event: 'command.execute',
            payload: { command, viaAccelerator: isViaAccelerator },
        });
}

/**
 * The hand-offs an optional window (Caxri Bot) uses to show something in the Workbench, which it cannot render itself:
 * a Session, or Settings. Each raises the Workbench first, reopening it when it was closed.
 */
export function createWorkbenchHandOffs(options: {
    dispatchWorkbenchCommand: (command: CommandId, isViaAccelerator: boolean) => void;
    /**
     * Raises a Workbench window: the primary window by default, or the window that owns a Session.
     */
    focusMainWindow: (windowKey?: string) => Promise<unknown>;
    sendEvent: (event: ServerEvent) => void;
    supervisor: () => DesktopServerConnection;
}): Pick<MainMethodHandlerOptions, 'openSettingsInWorkbench' | 'revealSessionInWorkbench'> {
    return {
        revealSessionInWorkbench: async (sessionId) => {
            const { ownerWindowKey } = await options.supervisor().request('session.select', {
                sessionId,
                windowKey: PRIMARY_WINDOW_KEY,
            });
            await options.focusMainWindow(ownerWindowKey);
        },
        openSettingsInWorkbench: async (target) => {
            // Unlike a menu pick, wait for the Workbench Renderer: a reopened window must be listening for the event.
            await options.focusMainWindow();
            if (target) options.sendEvent({ event: 'settings.openRequested', payload: { target } });
            else options.dispatchWorkbenchCommand('settings.open', false);
        },
    };
}
