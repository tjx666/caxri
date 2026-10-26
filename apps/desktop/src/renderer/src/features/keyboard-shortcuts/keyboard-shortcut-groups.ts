import type { CommandDefinition, Keybinding } from '@caxri/protocol';
import { commandDefinitions, formatShortcut, sessionOpenPinnedCommandIds } from '@caxri/protocol';

/**
 * Category id for bound commands an extension contributes. Catalog categories never use it, so the cheatsheet can give
 * those commands their own heading without inventing a catalog entry.
 */
export const EXTENSION_SHORTCUT_CATEGORY = 'Extensions';

/**
 * Display text for one entry, resolved by the caller in the active UI language. Kept out of this module so it stays a
 * pure function of its inputs and testable without the i18n runtime.
 */
export interface KeyboardShortcutLabels {
    category(category: string): string;
    /**
     * Title of the single row that stands for the nine Switch to Pinned Session commands.
     */
    pinnedRangeTitle: string;
    title(command: { id: string; title: string }): string;
}

interface KeyboardShortcutEntry {
    category: string;
    categoryLabel: string;
    command: string;
    /**
     * Every live binding of the command, in `keybindings.jsonc` order, so a user who added a second chord sees both.
     */
    keys: string[];
    /**
     * The keys span a range (`⌘1` to `⌘9`) rather than being alternative bindings, so the row shows them joined by a
     * dash.
     */
    isRange?: boolean;
    /**
     * Words standing in for keycaps on a pointer gesture (`Double-click`), which no keybinding can express. Such a row
     * has no `keys`.
     */
    gesture?: string;
    title: string;
    titleLabel: string;
}

export interface KeyboardShortcutGroup {
    category: string;
    label: string;
    entries: KeyboardShortcutEntry[];
}

/**
 * Category id of the static Session list keys.
 */
const SIDEBAR_SHORTCUT_CATEGORY = 'Sidebar';

/**
 * Id of the synthetic row that replaces the nine Switch to Pinned Session commands.
 */
export const PINNED_RANGE_COMMAND = 'session.openPinned';

interface CommandTitleSource {
    category: string;
    id: string;
    title: string;
}

const catalogById = new Map<string, CommandDefinition>(
    commandDefinitions.map((command) => [command.id, command]),
);

/**
 * Catalog declaration order: category first appearance, then command order inside it. This is the order the palette and
 * the Settings keybinding editor already present, so the cheatsheet reads the same, and it does not depend on the order
 * a user happened to write `keybindings.jsonc` in.
 */
const catalogOrder = new Map<string, number>(
    commandDefinitions.map((command, index) => [command.id, index]),
);
const categoryOrder = new Map<string, number>();
for (const command of commandDefinitions)
    if (!categoryOrder.has(command.category))
        categoryOrder.set(command.category, categoryOrder.size);

/**
 * Resolves what the cheatsheet can honestly name. A binding with arguments to a command that requires them (the VS
 * Code-compatible `sendSequence`) is a different action per binding, which a shared title would misdescribe; a command
 * neither the catalog nor an extension titles has nothing to show but its raw id.
 */
function titleSource(
    binding: Keybinding,
    contributedTitles: ReadonlyMap<string, string>,
): CommandTitleSource | undefined {
    const definition = catalogById.get(binding.command);
    if (definition) {
        if (definition.requiresArguments) return undefined;
        return { category: definition.category, id: definition.id, title: definition.title };
    }
    const title = contributedTitles.get(binding.command);
    if (!title) return undefined;
    return { category: EXTENSION_SHORTCUT_CATEGORY, id: binding.command, title };
}

function compareEntries(left: KeyboardShortcutEntry, right: KeyboardShortcutEntry): number {
    const leftOrder = catalogOrder.get(left.command);
    const rightOrder = catalogOrder.get(right.command);
    if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
    return left.titleLabel.localeCompare(right.titleLabel);
}

function compareCategories(left: string, right: string): number {
    const extensions = categoryOrder.size;
    return (categoryOrder.get(left) ?? extensions) - (categoryOrder.get(right) ?? extensions);
}

/**
 * Groups every command that has an effective keybinding under its category. User overrides arrive already merged in
 * `keybindings`, so a removed default is simply absent and a rebound command shows its new chord.
 */
export function buildKeyboardShortcutGroups(
    keybindings: readonly Keybinding[],
    contributedCommands: ReadonlyArray<{ id: string; title: string }>,
    labels: KeyboardShortcutLabels,
): KeyboardShortcutGroup[] {
    const contributedTitles = new Map(
        contributedCommands.map((command) => [command.id, command.title]),
    );
    const entries = new Map<string, KeyboardShortcutEntry>();
    for (const binding of keybindings) {
        const source = titleSource(binding, contributedTitles);
        if (!source) continue;
        const existing = entries.get(source.id);
        if (existing) {
            if (!existing.keys.includes(binding.key)) existing.keys.push(binding.key);
            continue;
        }
        entries.set(source.id, {
            category: source.category,
            categoryLabel: labels.category(source.category),
            command: source.id,
            keys: [binding.key],
            title: source.title,
            titleLabel: labels.title(source),
        });
    }

    collapsePinnedRange(entries, labels);
    const groups = new Map<string, KeyboardShortcutGroup>();
    for (const entry of entries.values()) {
        let group = groups.get(entry.category);
        if (!group) {
            group = { category: entry.category, label: entry.categoryLabel, entries: [] };
            groups.set(entry.category, group);
        }
        group.entries.push(entry);
    }
    return groups
        .values()
        .toArray()
        .toSorted((left, right) => compareCategories(left.category, right.category))
        .map((group) => ({ ...group, entries: group.entries.toSorted(compareEntries) }));
}

/**
 * Nine near-identical rows ("Switch to Pinned Session N") would take a column of the sheet, so they fold into one row
 * showing the span of keys. Only when all nine have exactly one binding each; a partly rebound set stays expanded so no
 * binding is hidden behind a range that misdescribes it.
 */
function collapsePinnedRange(
    entries: Map<string, KeyboardShortcutEntry>,
    labels: KeyboardShortcutLabels,
): void {
    const pinned = sessionOpenPinnedCommandIds.map((id) => entries.get(id));
    const first = pinned[0];
    const last = pinned.at(-1);
    if (!first || !last) return;
    if (pinned.some((entry) => entry?.keys.length !== 1)) return;
    for (const id of sessionOpenPinnedCommandIds) entries.delete(id);
    entries.set(PINNED_RANGE_COMMAND, {
        ...first,
        command: PINNED_RANGE_COMMAND,
        isRange: true,
        keys: [first.keys[0], last.keys[0]],
        title: labels.pinnedRangeTitle,
        titleLabel: labels.pinnedRangeTitle,
    });
}

/**
 * Keys that act on the focused Session list rather than through the command catalog, so they would never reach the
 * sheet otherwise. Appended after the catalog groups.
 */
export function sidebarShortcutGroup(
    labels: Record<'archive' | 'category' | 'collapse' | 'expand' | 'move', string>,
): KeyboardShortcutGroup {
    const entry = (command: string, title: string, keys: string[]): KeyboardShortcutEntry => ({
        category: SIDEBAR_SHORTCUT_CATEGORY,
        categoryLabel: labels.category,
        command,
        keys,
        title,
        titleLabel: title,
    });
    return {
        category: SIDEBAR_SHORTCUT_CATEGORY,
        label: labels.category,
        entries: [
            entry('sidebar.move', labels.move, ['arrowup', 'arrowdown']),
            entry('sidebar.collapse', labels.collapse, ['arrowleft']),
            entry('sidebar.expand', labels.expand, ['arrowright']),
            entry('sidebar.archive', labels.archive, ['delete']),
        ],
    };
}

const CHAT_COMPOSER_SHORTCUT_CATEGORY = 'Chat composer';
const MOUSE_SHORTCUT_CATEGORY = 'Mouse';

/**
 * Keys the Chat message input handles itself (`agent-chat-composer-keys.ts`, `agent-chat-prompt-history.ts`, the
 * suggestion lists), so they are not commands and would never reach the sheet otherwise. `/`, `$` and `@` are typed
 * characters rather than chords; the keycap shows the character that opens the list.
 */
export function chatComposerShortcutGroup(
    labels: Record<
        | 'category'
        | 'history'
        | 'mention'
        | 'newLine'
        | 'queue'
        | 'send'
        | 'skills'
        | 'slash'
        | 'stop',
        string
    >,
): KeyboardShortcutGroup {
    const entry = (command: string, title: string, keys: string[]): KeyboardShortcutEntry => ({
        category: CHAT_COMPOSER_SHORTCUT_CATEGORY,
        categoryLabel: labels.category,
        command,
        keys,
        title,
        titleLabel: title,
    });
    return {
        category: CHAT_COMPOSER_SHORTCUT_CATEGORY,
        label: labels.category,
        entries: [
            entry('chatComposer.send', labels.send, ['enter']),
            entry('chatComposer.queue', labels.queue, ['cmd+enter']),
            entry('chatComposer.newLine', labels.newLine, ['shift+enter']),
            entry('chatComposer.stop', labels.stop, ['escape']),
            entry('chatComposer.history', labels.history, ['arrowup']),
            entry('chatComposer.slash', labels.slash, ['/']),
            entry('chatComposer.skills', labels.skills, ['$']),
            entry('chatComposer.mention', labels.mention, ['@']),
        ],
    };
}

/**
 * Pointer gestures the app responds to, each verified against its handler: Cmd-click on a Terminal link
 * (`terminal-link-click-guard.ts`), double-click on a Session row (`session-row-trigger.tsx`), dragging a tab onto a
 * pane edge (`pane-drop-zone.ts`), and Option-click on a Files folder (`file-tree-item.tsx`).
 */
export function mouseShortcutGroup(
    labels: Record<
        | 'category'
        | 'dragTab'
        | 'dragTabGesture'
        | 'expandAll'
        | 'expandAllGesture'
        | 'link'
        | 'linkGesture'
        | 'rename'
        | 'renameGesture',
        string
    >,
): KeyboardShortcutGroup {
    const entry = (command: string, title: string, gesture: string): KeyboardShortcutEntry => ({
        category: MOUSE_SHORTCUT_CATEGORY,
        categoryLabel: labels.category,
        command,
        gesture,
        keys: [],
        title,
        titleLabel: title,
    });
    return {
        category: MOUSE_SHORTCUT_CATEGORY,
        label: labels.category,
        entries: [
            entry('mouse.openLink', labels.link, labels.linkGesture),
            entry('mouse.renameSession', labels.rename, labels.renameGesture),
            entry('mouse.splitByDrag', labels.dragTab, labels.dragTabGesture),
            entry('mouse.expandAll', labels.expandAll, labels.expandAllGesture),
        ],
    };
}

function isEntryMatching(entry: KeyboardShortcutEntry, needle: string): boolean {
    return [
        ...(entry.gesture ? [entry.gesture] : []),
        entry.titleLabel,
        entry.title,
        entry.categoryLabel,
        entry.category,
        ...entry.keys,
        ...entry.keys.map((key) => formatShortcut(key)),
    ].some((value) => value.toLowerCase().includes(needle));
}

/**
 * Matches the displayed title and category, their English catalog text, and each shortcut both as stored (`cmd+k
 * cmd+s`) and as shown (`⌘K ⌘S`). Groups with no matching entry drop out, so no heading stands over nothing.
 */
export function filterKeyboardShortcutGroups(
    groups: readonly KeyboardShortcutGroup[],
    query: string,
): KeyboardShortcutGroup[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...groups];
    return groups.flatMap((group) => {
        const entries = group.entries.filter((entry) => isEntryMatching(entry, needle));
        return entries.length > 0 ? [{ ...group, entries }] : [];
    });
}
