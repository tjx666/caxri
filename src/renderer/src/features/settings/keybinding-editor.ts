import { commandDefinitions, defaultKeybindings } from '@shared/commands';
import type { Keybinding } from '@shared/types';

import { formatShortcut } from '../../lib/keybindings';
import { applyFormEdit } from './config-edit';

export interface KeybindingRow {
    bindingIndex?: number;
    category: string;
    command: string;
    defaultKey?: string;
    description: string;
    id: string;
    key?: string;
    title: string;
}

const catalogById = new Map(commandDefinitions.map((command) => [command.id, command]));
const defaultByCommand = new Map(
    defaultKeybindings.map((binding) => [binding.command, binding.key]),
);

const modifierKeyNames = new Set(['Alt', 'Control', 'Meta', 'Shift']);

/** A lone modifier key press only arms further recording; it never forms a shortcut by itself. */
export function isModifierKey(key: string): boolean {
    return modifierKeyNames.has(key);
}

/**
 * `Tab`/`Shift+Tab` must keep moving focus even while the shortcut recorder is active, so the
 * recorder never captures them as part of a shortcut. Without this, Tab would get trapped on the
 * recording button and the browser's normal focus order would break.
 */
export function isFocusNavigationKey(key: string): boolean {
    return key === 'Tab';
}

/** Builds lossless source-order rows, followed by catalog commands that have no binding. */
export function buildKeybindingRows(keybindings: readonly Keybinding[]): KeybindingRow[] {
    const occurrences = new Map<string, number>();
    const boundCommands = new Set<string>();
    const rows = keybindings.map((binding, bindingIndex): KeybindingRow => {
        const occurrence = occurrences.get(binding.command) ?? 0;
        occurrences.set(binding.command, occurrence + 1);
        boundCommands.add(binding.command);
        const definition = catalogById.get(binding.command);
        return {
            bindingIndex,
            category: definition?.category ?? 'Custom',
            command: binding.command,
            defaultKey: defaultByCommand.get(binding.command),
            description: definition?.description ?? 'Custom command not present in the catalog',
            id: `binding:${binding.command}:${occurrence}`,
            key: binding.key,
            title: definition?.title ?? binding.command,
        };
    });
    for (const definition of commandDefinitions) {
        if (boundCommands.has(definition.id)) continue;
        rows.push({
            category: definition.category,
            command: definition.id,
            defaultKey: defaultByCommand.get(definition.id),
            description: definition.description,
            id: `catalog:${definition.id}`,
            title: definition.title,
        });
    }
    return rows;
}

export function filterKeybindingRows(
    rows: readonly KeybindingRow[],
    query: string,
): KeybindingRow[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...rows];
    return rows.filter((row) =>
        [
            row.title,
            row.command,
            row.category,
            row.key ?? '',
            row.key ? formatShortcut(row.key) : '',
        ].some((value) => value.toLowerCase().includes(needle)),
    );
}

export function updateKeybindingSource(source: string, index: number, key: string): string {
    return applyFormEdit(source, [index, 'key'], key);
}

export function removeKeybindingSource(source: string, index: number): string {
    return applyFormEdit(source, [index], undefined);
}

export function appendKeybindingSource(
    source: string,
    bindingCount: number,
    binding: Keybinding,
): string {
    return applyFormEdit(source, [bindingCount], binding);
}
