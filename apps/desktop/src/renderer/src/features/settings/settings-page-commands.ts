import { isEditableEventTarget } from '../../lib/keybindings';
import { closeSettings, useDialogStore } from '../../stores/dialogs';
import { getBootstrap } from '../../stores/selectors';

/**
 * Whether `settings.close` may take the key that triggered it. `Escape` inside a dialog belongs to that dialog, which
 * renders outside the page; the one exception is the Command Palette running this command. A text control keeps its own
 * `Escape`, except an empty Settings search field: a non-empty one clears itself first (`SettingsSearchInput`), and an
 * empty one has nothing left to do with it.
 */
export function canCloseSettingsPage(): boolean {
    if (!useDialogStore.getState().settingsPageOpen) return false;
    const focused = document.activeElement;
    if (!focused || focused === document.body) return true;
    // The Command Palette marks itself closed before it runs a command, so an open one is a keystroke typed into it.
    if (focused.closest('[data-command-palette]')) return !useDialogStore.getState().paletteOpen;
    if (isEditableEventTarget(focused))
        return (
            focused instanceof HTMLInputElement &&
            Object.hasOwn(focused.dataset, 'settingsSearch') &&
            focused.value === ''
        );
    return focused.closest('[data-settings-page]') !== null;
}

/**
 * Closes the Settings page for `Cmd+W`, handing focus back. The page covers the Workbench, so the tab `Cmd+W` would
 * otherwise close is one nobody can see. Returns whether it closed anything.
 */
export function didCloseSettingsForTabClose(): boolean {
    if (!useDialogStore.getState().settingsPageOpen) return false;
    closeSettings({ restoreFocus: true });
    return true;
}

/**
 * Opening a document in the selected Session is a request to look at it, so the Settings page that covers the Workbench
 * steps aside. Closed when the open starts rather than when its read lands, so a file read still in flight when the
 * user pressed `Cmd+,` cannot close Settings again behind their back.
 */
export function revealSelectedSessionWorkbench(sessionId: string): void {
    if (getBootstrap()?.selectedSessionId === sessionId) closeSettings({ restoreFocus: false });
}
