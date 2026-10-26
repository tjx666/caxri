import { Fragment, useMemo, useState } from 'react';

import { Search } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { ShortcutBadge } from '../../components/shortcut-badge';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input, InputGroup } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import { commandCategory, commandTitle } from '../../lib/command-labels';
import { useCaxriQuery } from '../../queries/client';
import { setKeyboardShortcutsOpen, useDialogStore } from '../../stores/dialogs';
import { useWorkbenchStore } from '../../stores/workbench';
import type { KeyboardShortcutGroup } from './keyboard-shortcut-groups';
import {
    buildKeyboardShortcutGroups,
    chatComposerShortcutGroup,
    EXTENSION_SHORTCUT_CATEGORY,
    filterKeyboardShortcutGroups,
    mouseShortcutGroup,
    sidebarShortcutGroup,
} from './keyboard-shortcut-groups';
import { PendingChordHint } from './pending-chord-hint';

const NO_KEYBINDINGS: never[] = [];

/**
 * Keyboard Shortcuts cheatsheet (`Command+K Command+R`, Help menu): a read-only reference of every live binding,
 * grouped by command category, modeled on Claude Code Desktop's shortcut list. Editing stays in the Settings
 * Keybindings page, one click away in the footer. The dialog stays mounted for the app's lifetime; its body, and with
 * it the keybinding and view-catalog reads, only mounts while it is open.
 */
export function KeyboardShortcutsDialog() {
    const isOpen = useDialogStore((state) => state.keyboardShortcutsOpen);
    return (
        <>
            <Dialog open={isOpen} onOpenChange={setKeyboardShortcutsOpen}>
                <DialogContent className="grid h-[min(640px,calc(100vh-48px))] w-[min(760px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden">
                    <KeyboardShortcutsBody />
                </DialogContent>
            </Dialog>
            {/* Mounted here because this host lives for the whole app and already owns the shortcut surfaces. */}
            <PendingChordHint />
        </>
    );
}

function KeyboardShortcutsBody() {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const keybindings =
        useWorkbenchStore((state) => state.bootstrap?.keybindings) ?? NO_KEYBINDINGS;
    const contributedCommands = useCaxriQuery('viewContainers.catalog', {}).data?.commands;
    const groups = useMemo(
        () => [
            ...buildKeyboardShortcutGroups(keybindings, contributedCommands ?? NO_KEYBINDINGS, {
                category: (category) =>
                    category === EXTENSION_SHORTCUT_CATEGORY
                        ? t('keyboardShortcuts.extensionsCategory')
                        : commandCategory(category, t),
                pinnedRangeTitle: t('keyboardShortcuts.pinnedRange'),
                title: (command) => commandTitle(command, t),
            }),
            sidebarShortcutGroup({
                archive: t('keyboardShortcuts.sidebar.archive'),
                category: t('keyboardShortcuts.sidebar.category'),
                collapse: t('keyboardShortcuts.sidebar.collapse'),
                expand: t('keyboardShortcuts.sidebar.expand'),
                move: t('keyboardShortcuts.sidebar.move'),
            }),
            chatComposerShortcutGroup({
                category: t('keyboardShortcuts.composer.category'),
                history: t('keyboardShortcuts.composer.history'),
                mention: t('keyboardShortcuts.composer.mention'),
                newLine: t('keyboardShortcuts.composer.newLine'),
                queue: t('keyboardShortcuts.composer.queue'),
                send: t('keyboardShortcuts.composer.send'),
                skills: t('keyboardShortcuts.composer.skills'),
                slash: t('keyboardShortcuts.composer.slash'),
                stop: t('keyboardShortcuts.composer.stop'),
            }),
            mouseShortcutGroup({
                category: t('keyboardShortcuts.mouse.category'),
                dragTab: t('keyboardShortcuts.mouse.dragTab'),
                dragTabGesture: t('keyboardShortcuts.mouse.dragTabGesture'),
                expandAll: t('keyboardShortcuts.mouse.expandAll'),
                expandAllGesture: t('keyboardShortcuts.mouse.expandAllGesture'),
                link: t('keyboardShortcuts.mouse.link'),
                linkGesture: t('keyboardShortcuts.mouse.linkGesture'),
                rename: t('keyboardShortcuts.mouse.rename'),
                renameGesture: t('keyboardShortcuts.mouse.renameGesture'),
            }),
        ],
        [contributedCommands, keybindings, t],
    );
    const visibleGroups = useMemo(
        () => filterKeyboardShortcutGroups(groups, query),
        [groups, query],
    );

    return (
        <>
            <DialogHeader>
                <DialogTitle>{t('keyboardShortcuts.title')}</DialogTitle>
            </DialogHeader>
            <div className="border-b border-border px-4 py-2">
                <InputGroup appearance="workbench" size="dense">
                    <Search aria-hidden="true" size={14} className="shrink-0 text-muted" />
                    <Input
                        autoFocus
                        appearance="embedded"
                        className="flex-1 text-foreground"
                        aria-label={t('keyboardShortcuts.searchLabel')}
                        maxLength={200}
                        placeholder={t('keyboardShortcuts.searchPlaceholder')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </InputGroup>
            </div>
            <div className="min-h-0 overflow-y-auto px-4 py-3">
                {visibleGroups.length > 0 ? (
                    <div className="columns-2 gap-x-8">
                        {visibleGroups.map((group) => (
                            <KeyboardShortcutSection key={group.category} group={group} />
                        ))}
                    </div>
                ) : (
                    <p className="m-0 p-4 text-center text-muted">
                        {t(
                            groups.length > 0
                                ? 'keyboardShortcuts.noMatches'
                                : 'keyboardShortcuts.none',
                        )}
                    </p>
                )}
            </div>
            <div className="flex justify-end border-t border-border px-4 py-2">
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                        setKeyboardShortcutsOpen(false);
                        executeCommand('settings.openKeybindings');
                    }}
                >
                    {t('keyboardShortcuts.editKeybindings')}
                </Button>
            </div>
        </>
    );
}

/**
 * One category block. `break-inside-avoid` keeps a heading and its rows in the same column, so a short category never
 * splits across the column gap.
 */
function KeyboardShortcutSection({ group }: { group: KeyboardShortcutGroup }) {
    return (
        <section
            className="mb-4 break-inside-avoid"
            data-keyboard-shortcut-category={group.category}
        >
            <h3 className="m-0 mb-1 text-[11px] font-semibold tracking-[0.04em] text-muted uppercase">
                {group.label}
            </h3>
            <ul className="m-0 list-none p-0">
                {group.entries.map((entry) => (
                    <li
                        key={entry.command}
                        className="flex min-h-7 items-center justify-between gap-3 text-[12px]"
                        data-keyboard-shortcut-command={entry.command}
                    >
                        <span className="min-w-0 truncate text-foreground">{entry.titleLabel}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                            {entry.gesture && <span className="text-muted">{entry.gesture}</span>}
                            {entry.keys.map((key, index) => (
                                <Fragment key={key}>
                                    {entry.isRange && index > 0 && (
                                        <span aria-hidden="true" className="text-muted">
                                            –
                                        </span>
                                    )}
                                    <ShortcutBadge compact shortcut={key} />
                                </Fragment>
                            ))}
                        </span>
                    </li>
                ))}
            </ul>
        </section>
    );
}
