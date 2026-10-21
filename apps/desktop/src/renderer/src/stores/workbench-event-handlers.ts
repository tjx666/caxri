import type { CommandId, ServerEvent, SettingsTarget } from '@caxri/protocol';

/**
 * Split out of `workbench.ts` (source-layout / ESLint `max-lines`): this interface's own callers still live there, but
 * the store file was already at the repository's 800-line budget before the Settings deep-link hand-off added its third
 * handler.
 */
export interface WorkbenchEventHandlers {
    /**
     * Runs a command id pushed by the native menu, honouring the modal guard. `wasViaAccelerator` forwards whether the
     * menu item fired from its keyboard accelerator rather than a mouse/touch click, so the caller can apply the
     * editable-focus shortcut policy only to the accelerator path.
     */
    onCommand(command: CommandId, wasViaAccelerator: boolean): void;
    /**
     * Applies an authenticated Server open request after Main redeemed its one-use target. `focusEditor` is the opening
     * caller's intent, forwarded unchanged from `desktop.openFile`; a `directory` kind with a `path` asks to reveal
     * that directory in Files.
     */
    onDesktopOpen(
        request: Extract<ServerEvent, { event: 'desktop.openRequested' }>['payload'],
    ): void;
    /**
     * Opens Settings scrolled to one row; Main sends this instead of the zero-argument `command.execute` bus.
     */
    onSettingsTarget(target: SettingsTarget): void;
}
