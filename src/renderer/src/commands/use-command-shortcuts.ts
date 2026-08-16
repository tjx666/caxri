import { useEffect } from 'react';

import type { CommandId, Keybinding } from '@shared/types';

import { buildShortcutMap, isEditableEventTarget, keyboardEventShortcut } from '../lib/keybindings';
import { useWorkbenchStore } from '../stores/workbench';
import { isCommandAvailable, runCommand } from './execute';
import { getRegisteredCommand } from './registry';

/**
 * Global keyboard dispatch. The binding table is read from the store at keystroke time, so the listener is installed
 * once instead of being torn down on every snapshot refresh. The chord map is rebuilt only when the keybinding array
 * reference changes (a settings update), not on every keystroke.
 *
 * A bound shortcut is always consumed, even while a modal is open: `Command+W` must not fall through to Electron's
 * window close just because {@link runCommand} declines to act behind a dialog.
 */
export function useCommandShortcuts(): void {
    useEffect(() => {
        let cachedKeybindings: Keybinding[] | undefined;
        let shortcutMap = new Map<string, string>();

        const onKeyDown = (event: KeyboardEvent): void => {
            /**
             * An IME composition keystroke (e.g. picking a Pinyin candidate) is not a shortcut.
             */
            if (event.isComposing) return;
            const bootstrap = useWorkbenchStore.getState().bootstrap;
            if (!bootstrap) return;
            if (bootstrap.keybindings !== cachedKeybindings) {
                cachedKeybindings = bootstrap.keybindings;
                shortcutMap = buildShortcutMap(cachedKeybindings);
            }
            const commandId = shortcutMap.get(keyboardEventShortcut(event));
            if (!commandId) return;
            const definition = getRegisteredCommand(commandId);
            /**
             * A contextual shortcut must fall through untouched so the owning editor can handle the same chord
             * (Terminal `Cmd+F` versus Monaco's native Find widget).
             */
            if (!isCommandAvailable(commandId)) return;
            /**
             * The terminal and the editor are editable surfaces too; only opted-in commands reach through.
             */
            if (isEditableEventTarget(event.target) && !definition?.allowInEditable) return;
            event.preventDefault();
            runCommand(commandId as CommandId);
        };
        addEventListener('keydown', onKeyDown);
        return () => removeEventListener('keydown', onKeyDown);
    }, []);
}
