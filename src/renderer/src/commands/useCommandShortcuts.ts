import { useEffect } from 'react';

import { keyboardEventShortcut, normalizeShortcut } from '../lib/keybindings';
import { useWorkbenchStore } from '../state/workbench';
import { runCommand } from './execute';

/**
 * Global keyboard dispatch. The binding table is read from the store at keystroke time, so the
 * listener is installed once instead of being torn down on every snapshot refresh.
 *
 * A bound shortcut is always consumed, even while a modal is open: `Command+W` must not fall through
 * to Electron's window close just because {@link runCommand} declines to act behind a dialog.
 */
export function useCommandShortcuts(): void {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            const bootstrap = useWorkbenchStore.getState().bootstrap;
            if (!bootstrap) return;
            const shortcut = keyboardEventShortcut(event);
            const binding = bootstrap.keybindings.find(
                (item) => normalizeShortcut(item.key) === shortcut,
            );
            if (!binding) return;
            event.preventDefault();
            runCommand(binding.command);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);
}
