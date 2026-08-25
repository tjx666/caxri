import { useEffect } from 'react';

import type { CommandId, Keybinding } from '@shared/types';

import {
    executeEditableViewCatalogShortcut,
    executeViewCatalogShortcut,
    getCachedViewCatalogCommandAllowedInEditable,
} from '../features/view-containers/view-container-commands';
import {
    buildShortcutMap,
    isEditableEventTarget,
    isKeybindingRecordingEventTarget,
    isTerminalEventTarget,
    keyboardEventShortcut,
    resolveShortcutBinding,
} from '../lib/keybindings';
import { useDialogStore } from '../stores/dialogs';
import { useWorkbenchStore } from '../stores/workbench';
import { isCommandAvailable, runCommand } from './execute';
import type { SessionMruShortcutInvocation } from './registry';
import { getRegisteredCommand } from './registry';

function sessionMruShortcutInvocation(event: KeyboardEvent): SessionMruShortcutInvocation {
    return {
        heldModifiers: [
            event.altKey && 'Alt',
            event.ctrlKey && 'Control',
            event.metaKey && 'Meta',
            event.shiftKey && 'Shift',
        ].filter((modifier): modifier is SessionMruShortcutInvocation['heldModifiers'][number] =>
            Boolean(modifier),
        ),
        triggerCode: event.code,
    };
}

/**
 * Global keyboard dispatch. Capture phase lets opted-in commands run before xterm or Monaco stop an editable target's
 * event. The binding table is read from the store at keystroke time, so the listener is installed once instead of being
 * torn down on every snapshot refresh. The chord map is rebuilt only when the keybinding array reference changes (a
 * settings update), not on every keystroke.
 *
 * A bound shortcut is always consumed, even while a modal is open: `Command+W` must not fall through to Electron's
 * window close just because {@link runCommand} declines to act behind a dialog.
 */
export function useCommandShortcuts(): void {
    useEffect(() => {
        let cachedKeybindings: Keybinding[] | undefined;
        let shortcutMap = new Map<string, Keybinding[]>();

        const onKeyDown = (event: KeyboardEvent): void => {
            /**
             * An IME composition keystroke (e.g. picking a Pinyin candidate) is not a shortcut.
             */
            if (event.isComposing) return;
            if (isKeybindingRecordingEventTarget(event.target)) return;
            const bootstrap = useWorkbenchStore.getState().bootstrap;
            if (!bootstrap) return;
            if (bootstrap.keybindings !== cachedKeybindings) {
                cachedKeybindings = bootstrap.keybindings;
                shortcutMap = buildShortcutMap(cachedKeybindings);
            }
            const binding = resolveShortcutBinding(shortcutMap, keyboardEventShortcut(event), {
                terminalFocus: isTerminalEventTarget(event.target),
            });
            if (!binding) return;
            const commandId = binding.command;
            const definition = getRegisteredCommand(commandId);
            /**
             * A contextual shortcut must fall through untouched so the owning editor can handle the same chord
             * (Terminal `Cmd+F` versus Monaco's native Find widget).
             */
            if (definition && !isCommandAvailable(commandId)) return;
            /**
             * The terminal and the editor are editable surfaces too; only opted-in commands reach through.
             */
            const isEditable = isEditableEventTarget(event.target);
            if (isEditable && !definition) {
                const cachedPermission = getCachedViewCatalogCommandAllowedInEditable(commandId);
                if (cachedPermission !== true) {
                    if (cachedPermission === undefined) {
                        event.preventDefault();
                        event.stopPropagation();
                        // Fire-and-forget: the manifest lookup is the fail-safe gate for a cold extension catalog.
                        // eslint-disable-next-line no-void -- one keydown owns one asynchronous policy lookup
                        void executeEditableViewCatalogShortcut(
                            commandId,
                            binding.args ? [binding.args] : [],
                        );
                    }
                    return;
                }
            }
            if (isEditable && definition && !definition.allowInEditable) return;
            event.preventDefault();
            event.stopPropagation();
            if (useDialogStore.getState().isModalOpen()) return;
            if (definition)
                runCommand(
                    commandId as CommandId,
                    commandId === 'session.switchMru'
                        ? { ...binding.args, shortcut: sessionMruShortcutInvocation(event) }
                        : binding.args,
                );
            else {
                // Fire-and-forget: the shared shortcut helper reports catalog and command failures through toasts.
                // eslint-disable-next-line no-void -- one keydown owns one asynchronous extension command dispatch
                void executeViewCatalogShortcut(commandId, binding.args ? [binding.args] : []);
            }
        };
        addEventListener('keydown', onKeyDown, { capture: true });
        return () => removeEventListener('keydown', onKeyDown, { capture: true });
    }, []);
}
