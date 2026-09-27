import type { CommanderIdentity, ServerEvent } from '@caxri/protocol';

/**
 * What one Server event asks the Agent Commander window to do. The window keeps two views current: its own
 * Commander-scoped Workbench snapshot (for the Terminal pane) and the board of every other Session.
 */
interface CommanderEventEffect {
    /**
     * Refetch `commander.board`; the caller debounces, because a busy Workbench emits bursts of `state.changed`.
     */
    board: boolean;
    /**
     * Run `commander.ensure` again: the Server that owned the Commander's PTY is gone. The Server restores only the
     * Workbench's selected Session, never the Commander's, so without this the window waits on a Terminal nothing
     * restarts.
     */
    ensure: boolean;
    /**
     * Mounted Terminal panes must re-issue `terminal.attach`: a Server restart or a Desktop↔Server reconnect dropped
     * the attachment and any PTY output sent meanwhile.
     */
    reattach: boolean;
    /**
     * Re-read `commander.snapshot` and replace the Workbench store's snapshot.
     */
    snapshot: boolean;
}

const NO_EFFECT: CommanderEventEffect = {
    board: false,
    ensure: false,
    reattach: false,
    snapshot: false,
};

/**
 * Maps one Server event onto the window's refreshes. Unlike the Workbench's `subscribeWorkbenchEvents`, this handler is
 * deliberately partial: UI commands (`command.execute`, `desktop.openRequested`) belong to the Workbench window, and
 * every other event only ever concerns state this window does not render.
 *
 * `identity` is undefined until `commander.ensure` resolves. A `records` change is then answered with a snapshot read
 * anyway, because without the Commander's IDs there is no way to prove it did not name them; the caller defers that
 * read until the first snapshot lands.
 */
export function commanderEventEffect(
    event: ServerEvent,
    identity: CommanderIdentity | undefined,
): CommanderEventEffect {
    switch (event.event) {
        case 'state.changed': {
            const { payload } = event;
            const isOwnRecord =
                payload.kind === 'full' ||
                identity === undefined ||
                payload.sessionIds.includes(identity.sessionId) ||
                payload.terminalIds.includes(identity.terminalId);
            return { ...NO_EFFECT, board: true, snapshot: isOwnRecord };
        }
        case 'runtime.status':
            return event.payload.status === 'ready'
                ? { board: true, ensure: true, reattach: true, snapshot: true }
                : NO_EFFECT;
        case 'host.connectionChanged':
            // `replaced` means another window took over this profile; the Workbench window reports it.
            return event.payload.status === 'replaced'
                ? NO_EFFECT
                : {
                      board: true,
                      ensure: event.payload.isHostReplaced,
                      reattach: true,
                      snapshot: true,
                  };
        case 'settings.changed':
        case 'keybindings.changed':
        case 'theme.changed':
            // A configuration error is reported by the Workbench window, which owns Settings.
            return event.payload.error ? NO_EFFECT : { ...NO_EFFECT, snapshot: true };
        case 'sessionPullRequests.changed':
            return { ...NO_EFFECT, board: true };
        default:
            return NO_EFFECT;
    }
}
