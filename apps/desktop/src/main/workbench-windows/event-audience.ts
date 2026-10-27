import type { ServerEvent } from '@caxri/protocol';

/**
 * Which Workbench windows a Main event reaches once more than one exists.
 *
 * - `all`: every window renders the same shared state (Server state, Terminal output, settings), so each applies it.
 * - `focused`: a one-shot command meant for the window the user is working in (a menu accelerator, an Editor open
 *   request, a GPU recovery toast). Delivering it to every window would run it twice.
 * - `target`: the sender addresses one window explicitly (an unsaved-editor question, a window's own fullscreen state).
 */
export type EventAudience = 'all' | 'focused' | 'target';

/**
 * Exhaustive over {@link ServerEvent}: adding an event fails to compile until its audience is decided here, so a new
 * window-directed event cannot silently broadcast to every window.
 */
export const EVENT_AUDIENCE = {
    'viewContainers.catalogChanged': 'all',
    'viewContainers.treeChanged': 'all',
    'viewContainers.viewChanged': 'all',
    'runtime.status': 'all',
    'state.changed': 'all',
    'agentTranscript.changed': 'all',
    'agentChat.patch': 'all',
    'agentChat.taskPatch': 'all',
    'terminal.output': 'all',
    'terminal.sizeOwnership': 'all',
    'terminal.outputRecovery': 'all',
    'terminal.resourceAlert': 'focused',
    'terminal.exit': 'all',
    'files.watchLimitAlert': 'focused',
    'files.changed': 'all',
    'files.operationChanged': 'all',
    'git.changed': 'all',
    'projectStatus.changed': 'all',
    'projectStatus.alert': 'focused',
    'sessionPullRequests.changed': 'all',
    'botInbox.changed': 'all',
    'benchmark.changed': 'all',
    'claudeWindow.changed': 'all',
    'gitReview.changed': 'all',
    'workbench.candidate': 'focused',
    'workbench.changed': 'all',
    'settings.changed': 'all',
    'agentHooks.changed': 'all',
    'agent.message.receipt': 'all',
    'agent.message.held': 'all',
    'agent.messaging.changed': 'all',
    'agent.dispatch.changed': 'all',
    'keybindings.changed': 'all',
    'theme.changed': 'all',
    'updates.state': 'all',
    'environment.changed': 'all',
    'environment.connectionReused': 'focused',
    'host.connectionChanged': 'all',
    'window.fullScreen': 'target',
    'externalDocument.changed': 'all',
    'editor.unsavedRequest': 'target',
    'agent.notification': 'focused',
    'notifications.helperUnavailable': 'focused',
    'session.autoArchived': 'focused',
    'agent.automaticNamingUnavailable': 'focused',
    'agent.permissionAutoAllowChanged': 'all',
    'gpu.recoveryRequested': 'focused',
    'desktop.openRequested': 'focused',
    'command.execute': 'focused',
    'settings.openRequested': 'focused',
    /**
     * Caxri Bot-only: `caxri-bot-window.ts` sends these straight to Caxri Bot's Renderer and they never pass through
     * the Workbench broadcast, so the audience is not consulted. `all` is only the closest member of
     * {@link EventAudience}; no narrower value exists.
     */
    'caxriBot.inboxRequested': 'all',
    'caxriBot.commandPaletteRequested': 'all',
} as const satisfies Record<ServerEvent['event'], EventAudience>;

export function eventAudience(event: ServerEvent): EventAudience {
    return EVENT_AUDIENCE[event.event];
}
