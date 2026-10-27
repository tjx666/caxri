import { useEffect, useRef } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { formatShortcutChords } from '@caxri/protocol';

import { useRelativeTime } from '@/hooks/use-relative-time';

import type { SessionMruShortcutInvocation } from '../../commands/registry';
import { ShortcutBadge } from '../../components/shortcut-badge';
import { Kbd } from '../../components/ui/kbd';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useCommandShortcut } from '../../lib/keybindings';
import { cn } from '../../lib/utilities';
import { useProjects, useSessions, useTerminals } from '../../stores/selectors';
import { ProjectIcon } from '../primary-sidebar/project-icon';
import { SessionStatusIndicator } from '../primary-sidebar/session-status-indicator';
import { sessionAgentTerminal } from './session-agent-terminal';
import { commitMruSession } from './session-commands';
import { resolveSessionMruView, useSessionMruSwitcherStore } from './session-mru-switcher-state';
import { sessionTitleForDisplay } from './session-title';

/**
 * Chord names for the modifiers the user is physically holding, so the release hint renders through the shared
 * `formatShortcutChords` symbol table instead of a second private mapping.
 */
const HELD_MODIFIER_CHORD_NAMES: Record<'Alt' | 'Control' | 'Meta' | 'Shift', string> = {
    Alt: 'alt',
    Control: 'ctrl',
    Meta: 'cmd',
    Shift: 'shift',
};

function useSessionMruSwitcherView() {
    const candidateIds = useSessionMruSwitcherStore((state) => state.candidateIds);
    const heldModifiers = useSessionMruSwitcherStore((state) => state.heldModifiers);
    const isOpen = useSessionMruSwitcherStore((state) => state.isOpen);
    const isVisible = useSessionMruSwitcherStore((state) => state.isVisible);
    const selectedIndex = useSessionMruSwitcherStore((state) => state.selectedIndex);
    const projects = useProjects() ?? [];
    const sessions = useSessions() ?? [];
    const terminals = useTerminals();
    return {
        candidateIds,
        heldModifiers,
        isOpen,
        isVisible,
        projects,
        selectedIndex,
        sessions,
        terminals,
    };
}

/**
 * Keeps the highlighted row inside the scroll viewport while the user cycles past the visible candidates. `nearest`
 * scrolls the minimum distance, so a switcher that already shows the row does not jump under the cursor.
 */
function useScrollSelectionIntoView(selectedIndex: number, isPanelVisible: boolean) {
    const listReference = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!isPanelVisible) return;
        listReference.current
            ?.querySelector('[aria-selected="true"]')
            ?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex, isPanelVisible]);
    return listReference;
}

function SessionMruRow({
    index,
    project,
    selected,
    session,
    terminal,
}: {
    index: number;
    project?: ProjectRecord;
    selected: boolean;
    session: SessionRecord;
    terminal?: TerminalRecord;
}) {
    const lastOpened = useRelativeTime(session.lastVisitedAt);
    const { t } = useTranslation();
    return (
        <div
            id={`session-mru-option-${session.id}`}
            className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-foreground',
                /*
                 * DESIGN.md principle 2 reserves `--accent` for the screen's single resting focus, with an explicit
                 * carve-out for transient, action-scoped feedback. The switcher exists only while its chord is held
                 * and its entire job is to show where the pending jump will land, so the highlighted row earns the
                 * accent ring the PrimarySidebar's persistent selection is denied.
                 */
                selected && 'bg-elevated ring-1 ring-accent/70 ring-inset',
            )}
            aria-selected={selected}
            data-session-id={session.id}
            role="option"
            onClick={() => {
                useSessionMruSwitcherStore.getState().select(index);
                commitMruSession();
            }}
            /*
             * `mousemove`, not `mouseenter`: the overlay can appear underneath a resting cursor, and an enter event
             * fired by the panel arriving (rather than by the user moving) would hijack the keyboard selection.
             */
            onMouseMove={() => useSessionMruSwitcherStore.getState().select(index)}
        >
            <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={16} />
            <span className="min-w-0 flex-1">
                <strong
                    className={cn(
                        'block truncate text-[13px]',
                        selected ? 'font-semibold' : 'font-medium',
                    )}
                >
                    {sessionTitleForDisplay(session.title, t)}
                </strong>
                <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                    <ProjectIcon className="flex-none" icon={project?.icon} size={11} />
                    <span className="truncate">
                        {project?.title ?? t('session.unknownProject')}
                    </span>
                </span>
            </span>
            <span className="flex-none text-[11px] text-muted tabular-nums">{lastOpened}</span>
            {/* The same right-edge lifecycle glyph as the PrimarySidebar row. */}
            <SessionStatusIndicator reserveSlot session={session} terminal={terminal} />
        </div>
    );
}

/**
 * The hold-to-cycle contract is invisible otherwise: nothing on screen says the chord repeats, that Shift reverses it,
 * or that releasing the modifiers is what commits. The chips read the live keybinding, so a rebound chord stays
 * honest.
 */
function SessionMruHint({
    heldModifiers,
}: {
    heldModifiers: SessionMruShortcutInvocation['heldModifiers'];
}) {
    const { t } = useTranslation();
    const shortcut = useCommandShortcut('session.switchMru');
    const [releaseParts = []] = formatShortcutChords(
        heldModifiers.map((modifier) => HELD_MODIFIER_CHORD_NAMES[modifier]).join('+'),
    );
    return (
        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted">
            {shortcut && (
                <span className="inline-flex items-center gap-1">
                    <ShortcutBadge compact shortcut={shortcut} />
                    {t('common.next')}
                </span>
            )}
            <span className="inline-flex items-center gap-1">
                <Kbd size="compact">⇧</Kbd>
                {t('common.previous')}
            </span>
            <span className="inline-flex items-center gap-1">
                <Kbd size="compact">Esc</Kbd>
                {t('common.cancel')}
            </span>
            {releaseParts.length > 0 && (
                <span className="ml-auto inline-flex items-center gap-1">
                    {t('session.mru.release')}
                    {releaseParts.map((part) => (
                        <Kbd key={part} size="compact">
                            {part}
                        </Kbd>
                    ))}
                    {t('session.mru.toSwitch')}
                </span>
            )}
        </div>
    );
}

/**
 * The switcher is mounted for the whole app lifetime but open only while its chord is held, so the closed case must not
 * subscribe to anything the Workbench churns. Reading the Project, Session, and Terminal stores below that gate would
 * rerender this overlay on every Terminal title and agent-metadata update (several times a second while an agent runs)
 * to decide it renders nothing.
 */
export function SessionMruSwitcher() {
    const isOpen = useSessionMruSwitcherStore((state) => state.isOpen);
    return isOpen ? <SessionMruSwitcherPanel /> : null;
}

function SessionMruSwitcherPanel() {
    const view = useSessionMruSwitcherView();
    const { t } = useTranslation();
    const {
        candidateIds,
        projects,
        selectedIndex: requestedSelectedIndex,
        sessions,
        terminals,
    } = view;
    const { candidates, selected, selectedIndex } = resolveSessionMruView(
        candidateIds,
        sessions,
        requestedSelectedIndex,
    );
    const isPanelVisible = Boolean(selected) && view.isOpen && view.isVisible;
    const listReference = useScrollSelectionIntoView(selectedIndex, isPanelVisible);
    useEffect(() => {
        if (!selected && view.isOpen) useSessionMruSwitcherStore.getState().cancel();
    }, [selected, view.isOpen]);
    if (!selected || !isPanelVisible) return null;
    return (
        <div className="fixed inset-0 z-[60] grid place-items-center">
            {/*
             * Transparent scrim, matching `PickerDialogContent`: like VS Code's editor switcher, the workbench stays
             * readable underneath. The scrim still takes pointer events so a click outside the panel cannot reach the
             * workbench: without that, clicking a PrimarySidebar Session while the chord is held switches the Session
             * and the switcher then commits a second, stale one on release. Clicking the scrim cancels, matching Escape.
             */}
            <div
                aria-hidden="true"
                className="absolute inset-0"
                onMouseDown={() => useSessionMruSwitcherStore.getState().cancel()}
            />
            <p className="sr-only" aria-atomic="true" role="status">
                {t('session.mru.selectedStatus', {
                    title: sessionTitleForDisplay(selected.title, t),
                    position: selectedIndex + 1,
                    total: candidates.length,
                })}
            </p>
            <div className="session-mru-switcher motion-safe:animate-in fade-in-0 zoom-in-95 pointer-events-auto relative flex w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-[0_16px_48px_var(--shadow)] duration-(--motion-overlay-enter) ease-(--motion-ease-enter)">
                <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                    <span className="text-[11px] font-bold tracking-[0.04em] text-foreground uppercase">
                        {t('session.mru.title')}
                    </span>
                    <span className="text-[11px] text-muted tabular-nums">
                        {selectedIndex + 1} / {candidates.length}
                    </span>
                </div>
                <div
                    ref={listReference}
                    className="max-h-[min(360px,50vh)] overflow-y-auto p-1.5"
                    aria-activedescendant={`session-mru-option-${selected.id}`}
                    aria-label={t('session.mru.title')}
                    role="listbox"
                    tabIndex={-1}
                >
                    {candidates.map((session, index) => (
                        <SessionMruRow
                            key={session.id}
                            index={index}
                            project={projects.find((item) => item.id === session.projectId)}
                            selected={index === selectedIndex}
                            session={session}
                            terminal={sessionAgentTerminal(session, terminals)}
                        />
                    ))}
                </div>
                <SessionMruHint heldModifiers={view.heldModifiers} />
            </div>
        </div>
    );
}
