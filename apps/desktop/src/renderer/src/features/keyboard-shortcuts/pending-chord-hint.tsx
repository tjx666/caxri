import { useMemo } from 'react';

import { ShortcutBadge } from '../../components/shortcut-badge';
import { useTranslation } from '../../i18n';
import { commandCategory, commandTitle } from '../../lib/command-labels';
import { useCaxriQuery } from '../../queries/client';
import { useWorkbenchStore } from '../../stores/workbench';
import { buildChordHints } from './chord-hints';
import { EXTENSION_SHORTCUT_CATEGORY } from './keyboard-shortcut-groups';
import { usePendingChordStore } from './pending-chord-store';

const NO_COMMANDS: never[] = [];

/**
 * The visible half of a pending chord. After `Cmd+K` the next keystroke is swallowed whether or not it matches, so
 * without this the app looks frozen; the hint names the keys that finish the sequence and what each runs.
 */
export function PendingChordHint() {
    const leadingChord = usePendingChordStore((state) => state.leadingChord);
    return leadingChord ? <ActivePendingChordHint leadingChord={leadingChord} /> : null;
}

function ActivePendingChordHint({ leadingChord }: { leadingChord: string }) {
    const { t } = useTranslation();
    const keybindings = useWorkbenchStore((state) => state.bootstrap?.keybindings);
    const contributedCommands = useCaxriQuery('viewContainers.catalog', {}).data?.commands;
    const hints = useMemo(
        () =>
            buildChordHints(
                keybindings ?? NO_COMMANDS,
                leadingChord,
                contributedCommands ?? NO_COMMANDS,
                {
                    category: (category) =>
                        category === EXTENSION_SHORTCUT_CATEGORY
                            ? t('keyboardShortcuts.extensionsCategory')
                            : commandCategory(category, t),
                    pinnedRangeTitle: t('keyboardShortcuts.pinnedRange'),
                    title: (command) => commandTitle(command, t),
                },
            ),
        [contributedCommands, keybindings, leadingChord, t],
    );
    return (
        <div
            className="pointer-events-none fixed inset-x-0 bottom-10 z-[100] flex justify-center"
            data-pending-chord-hint
            role="status"
        >
            <div className="motion-safe:animate-in fade-in-0 slide-in-from-bottom-2 flex max-h-[min(60vh,420px)] max-w-[min(520px,calc(100vw-48px))] min-w-64 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-elevated px-3 py-2 text-[12px] text-foreground shadow-[0_8px_24px_var(--shadow)] duration-(--motion-overlay-enter) ease-(--motion-ease-enter)">
                <p className="m-0 flex items-center gap-1.5 text-muted">
                    <ShortcutBadge compact shortcut={leadingChord} />
                    <span>{t('keyboardShortcuts.chordPending')}</span>
                </p>
                {hints.length > 0 && (
                    <ul className="m-0 flex list-none flex-col gap-1 overflow-hidden p-0">
                        {hints.map((hint) => (
                            <li
                                key={`${hint.command}:${hint.secondKey}`}
                                className="flex items-center justify-between gap-4"
                            >
                                <span className="min-w-0 truncate">{hint.title}</span>
                                <ShortcutBadge compact shortcut={hint.secondKey} />
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
