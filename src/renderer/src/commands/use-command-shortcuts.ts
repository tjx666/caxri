import { useEffect } from 'react';

import type { CommandId, Keybinding } from '@shared/types';

import {
    buildShortcutMap,
    isEditableEventTarget,
    isKeybindingRecordingEventTarget,
    isTerminalEventTarget,
    keyboardEventShortcut,
    resolveShortcutBinding,
} from '../lib/keybindings';
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
            const isDiagTarget = event.metaKey && event.key.toLowerCase() === 'w';
            const diag = (stage: string, extra?: Record<string, unknown>): void => {
                if (!isDiagTarget) return;

                console.log('DIAG_KEYDOWN', {
                    stage,
                    target:
                        event.target instanceof Element
                            ? event.target.tagName
                            : typeof event.target,
                    ...extra,
                });
            };
            /**
             * An IME composition keystroke (e.g. picking a Pinyin candidate) is not a shortcut.
             */
            if (event.isComposing) {
                diag('isComposing-return');
                return;
            }
            if (isKeybindingRecordingEventTarget(event.target)) {
                diag('isKeybindingRecordingEventTarget-return');
                return;
            }
            const bootstrap = useWorkbenchStore.getState().bootstrap;
            if (!bootstrap) {
                diag('no-bootstrap-return');
                return;
            }
            if (bootstrap.keybindings !== cachedKeybindings) {
                cachedKeybindings = bootstrap.keybindings;
                shortcutMap = buildShortcutMap(cachedKeybindings);
            }
            const binding = resolveShortcutBinding(shortcutMap, keyboardEventShortcut(event), {
                terminalFocus: isTerminalEventTarget(event.target),
            });
            diag('resolved-binding', {
                shortcut: keyboardEventShortcut(event),
                bindingCommand: binding?.command,
            });
            if (!binding) return;
            const commandId = binding.command;
            const definition = getRegisteredCommand(commandId);
            /**
             * A contextual shortcut must fall through untouched so the owning editor can handle the same chord
             * (Terminal `Cmd+F` versus Monaco's native Find widget).
             */
            if (!isCommandAvailable(commandId)) {
                diag('not-command-available-return', { commandId });
                return;
            }
            /**
             * The terminal and the editor are editable surfaces too; only opted-in commands reach through.
             */
            if (isEditableEventTarget(event.target) && !definition?.allowInEditable) {
                diag('editable-target-return', { commandId });
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            diag('calling-runCommand', { commandId });
            runCommand(
                commandId as CommandId,
                commandId === 'session.switchMru'
                    ? { ...binding.args, shortcut: sessionMruShortcutInvocation(event) }
                    : binding.args,
            );
        };
        addEventListener('keydown', onKeyDown, { capture: true });
        return () => removeEventListener('keydown', onKeyDown, { capture: true });
    }, []);
}
