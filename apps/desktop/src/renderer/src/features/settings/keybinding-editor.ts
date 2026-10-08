import type { CommandDefinition, Keybinding } from '@caxri/protocol';
import {
    commandDefinitions,
    defaultKeybindings,
    formatShortcut,
    MAX_SHORTCUT_CHORDS,
    splitShortcutChords,
} from '@caxri/protocol';

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

const catalogById = new Map<string, CommandDefinition>(
    commandDefinitions.map((command) => [command.id, command]),
);
const defaultByCommand = new Map<string, string>(
    defaultKeybindings.map((binding) => [binding.command, binding.key]),
);

/**
 * `Tab`/`Shift+Tab` must keep moving focus even while the shortcut recorder is active, so the recorder never captures
 * them as part of a shortcut. Without this, Tab would get trapped on the recording button and the browser's normal
 * focus order would break.
 */
export function isFocusNavigationKey(event: {
    altKey: boolean;
    ctrlKey: boolean;
    key: string;
    metaKey: boolean;
}): boolean {
    return event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/**
 * Builds lossless source-order rows, followed by catalog commands that have no binding.
 */
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
        if (boundCommands.has(definition.id) || definition.requiresArguments) continue;
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

export interface KeybindingRowGroup {
    category: string;
    rows: KeybindingRow[];
}

/**
 * Groups rows under their catalog category, in the order each category first appears in `rows`: the same "declaration
 * order becomes display order" convention `settings-registry.ts` uses for Settings' own categories.
 * `commandDefinitions` does not keep every category's entries contiguous (`View` alone reappears in three separate
 * blocks), so the flat list this replaces put same-category shortcuts on opposite ends of the page (issue caxri#1289:
 * "unbgrouped Keybindings list"). Grouping happens after search filtering, so a category with no matching row simply
 * has no heading, exactly like Settings.
 */
export function groupKeybindingRows(rows: readonly KeybindingRow[]): KeybindingRowGroup[] {
    const groups: KeybindingRowGroup[] = [];
    const groupByCategory = new Map<string, KeybindingRowGroup>();
    for (const row of rows) {
        let group = groupByCategory.get(row.category);
        if (!group) {
            group = { category: row.category, rows: [] };
            groupByCategory.set(row.category, group);
            groups.push(group);
        }
        group.rows.push(row);
    }
    return groups;
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

/**
 * In-progress shortcut capture for one row: armed but not yet holding a captured keybinding, or holding the
 * last-captured (but not yet committed) one.
 */
export interface RecordingState {
    pending?: string;
    rowId: string;
}

/**
 * Outcome of a recording state transition: the next state to render, and the keybinding to persist when the transition
 * is a commit.
 */
export interface RecordingResolution {
    next: RecordingState | undefined;
    commit?: string;
}

/**
 * Arms recording for a row with nothing captured yet.
 */
export function startRecording(rowId: string): RecordingState {
    return { rowId };
}

/**
 * Appends the captured chord, VS Code style: a second chord extends the capture into a sequence (`⌘K ⌘S`) instead of
 * replacing the first. Because appending means a mistyped first chord can no longer be fixed by simply pressing the
 * right one, {@link clearRecordingKey} is the explicit way to start over.
 */
export function captureRecordingKey(state: RecordingState, chord: string): RecordingState {
    const captured = state.pending ? splitShortcutChords(state.pending) : [];
    const next = captured.length >= MAX_SHORTCUT_CHORDS ? [chord] : [...captured, chord];
    return { ...state, pending: next.join(' ') };
}

/**
 * Discards what has been captured so far while staying armed, so a mistyped chord can be retyped without leaving and
 * re-entering recording.
 */
export function clearRecordingKey(state: RecordingState): RecordingState {
    return { rowId: state.rowId };
}

/**
 * Escape, Tab, and a blur with nothing captured yet all discard recording the same way.
 */
export function cancelRecording(): RecordingResolution {
    return { next: undefined };
}

/**
 * Enter only acts once a chord has been captured; with nothing captured yet it is a no-op (returns `undefined`) so
 * recording stays open for another attempt instead of silently closing.
 */
export function commitOnEnter(state: RecordingState): RecordingResolution | undefined {
    if (!state.pending) return undefined;
    return { next: undefined, commit: state.pending };
}

/**
 * Blur must never silently drop an already-captured chord: the historical bug this closes, where clicking away from the
 * recording button discarded the shortcut the user just pressed. A captured chord commits on blur exactly like Enter;
 * only a blur before any key was captured has nothing to lose, so it cancels recording instead.
 */
export function commitOnBlur(state: RecordingState): RecordingResolution {
    if (!state.pending) return cancelRecording();
    return { next: undefined, commit: state.pending };
}
