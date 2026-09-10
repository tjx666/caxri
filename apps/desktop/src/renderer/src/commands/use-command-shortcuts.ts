import { useEffect } from 'react';

import type { CommandId, Keybinding } from '@caxri/protocol';

import {
    executeEditableViewCatalogShortcut,
    executeViewCatalogShortcut,
    getCachedViewCatalogCommandAllowedInEditable,
} from '../features/view-containers/view-container-commands';
import {
    buildShortcutMap,
    isEditableEventTarget,
    isEditorEventTarget,
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
        direction: event.shiftKey ? -1 : 1,
        heldModifiers: [
            event.altKey && 'Alt',
            event.ctrlKey && 'Control',
            event.metaKey && 'Meta',
        ].filter((modifier): modifier is SessionMruShortcutInvocation['heldModifiers'][number] =>
            Boolean(modifier),
        ),
        triggerCode: event.code,
    };
}

/**
 * Shift reverses Session MRU instead of defining a second configurable binding. On a US macOS layout it also changes
 * the Backquote key's printable value to `~`, so an exact lookup cannot find the configured Command+Backquote chord.
 * Only the MRU command may fall back to the same chord without Shift; every other shifted chord keeps exact first-match
 * semantics.
 */
export function resolveKeydownBinding(
    shortcutMap: ReadonlyMap<string, readonly Keybinding[]>,
    event: KeyboardEvent,
    context: { terminalFocus: boolean },
): Keybinding | undefined {
    const exact = resolveShortcutBinding(shortcutMap, keyboardEventShortcut(event), context);
    if (exact || !event.shiftKey) return exact;
    const unshifted = resolveShortcutBinding(
        shortcutMap,
        keyboardEventShortcut(event, {
            mainKey: event.code === 'Backquote' ? '`' : undefined,
            omitShift: true,
        }),
        context,
    );
    return unshifted?.command === 'session.switchMru' ? unshifted : undefined;
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

        const onKeyDown = (event: KeyboardEvent, isBubbling = false): void => {
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
            const binding = resolveKeydownBinding(shortcutMap, event, {
                terminalFocus: isTerminalEventTarget(event.target),
            });
            if (!binding) return;
            const commandId = binding.command;
            /**
             * Monaco owns Cmd+K Cmd+J (Unfold All). Let it consume the continuation before Panel Toggle sees Cmd+J; an
             * unhandled standalone Cmd+J still bubbles here. Keep intentional app overrides in capture phase.
             */
            const shouldDeferToEditor =
                commandId === 'panel.toggle' && isEditorEventTarget(event.target);
            if (shouldDeferToEditor !== isBubbling) return;
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
        const onCapture = (event: KeyboardEvent): void => onKeyDown(event);
        const onBubble = (event: KeyboardEvent): void => onKeyDown(event, true);
        addEventListener('keydown', onCapture, { capture: true });
        addEventListener('keydown', onBubble);
        return () => {
            removeEventListener('keydown', onCapture, { capture: true });
            removeEventListener('keydown', onBubble);
        };
    }, []);
}
