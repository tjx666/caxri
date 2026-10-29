import { useMemo, useState } from 'react';

import type { AppLocale } from '@caxri/protocol';
import { Archive, ArchiveRestore, Search, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { localeDateTimeFormat } from '../../lib/locale-format';
import {
    setArchivedSessionsOpen,
    setSessionSearchOpen,
    useDialogStore,
} from '../../stores/dialogs';
import { useProjects, useSessions, useTerminals } from '../../stores/selectors';
import type {
    ArchivedSessionFilters,
    ArchivedSessionItem,
    ArchivedSessionView,
} from './archived-sessions';
import {
    deriveArchivedSessionView,
    pruneArchivedSelection,
    untitledArchivedSessionIds,
    visibleArchivedSessionIds,
} from './archived-sessions';
import { unarchiveSession, unarchiveSessions } from './session-archive-commands';
import { deleteSession, deleteSessions } from './session-commands';
import { sessionTitleForDisplay } from './session-title';

const NO_RECORDS: never[] = [];
const EMPTY_SELECTION: ReadonlySet<string> = new Set();
function archivedTimestamp(value: number, locale: AppLocale): string {
    return localeDateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' }, locale).format(value);
}

/**
 * Adds or removes a run of Sessions from the selection in one update, so the "select all" and "select untitled"
 * controls share the row checkbox's path instead of each keeping their own.
 */
type ToggleSessions = (sessionIds: readonly string[], isChecked: boolean) => void;

/**
 * The dialog is mounted for the app's lifetime, so everything that reads the Workbench stores lives in the body below.
 * Base UI's Portal renders nothing while the dialog is closed, so the body's hooks and its whole-archive derivation
 * only run while it is open: reading Projects, Sessions, and Terminals out here instead would rerun
 * `deriveArchivedSessionView` on every Terminal title and agent-metadata update, several times a second while an agent
 * runs, for a dialog nobody opened.
 */
export function ArchivedSessionsDialog() {
    const isOpen = useDialogStore((state) => state.archivedSessionsOpen);
    return (
        <Dialog open={isOpen} onOpenChange={setArchivedSessionsOpen}>
            <DialogContent className="grid h-[min(760px,calc(100vh-48px))] w-[min(980px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden">
                <ArchivedSessionsDialogBody />
            </DialogContent>
        </Dialog>
    );
}

function ArchivedFilterBar({
    agent,
    onAgentChange,
    onProjectChange,
    onQueryChange,
    query,
    view,
}: {
    agent: ArchivedSessionFilters['agent'];
    onAgentChange: (value: ArchivedSessionFilters['agent']) => void;
    onProjectChange: (value: string) => void;
    onQueryChange: (value: string) => void;
    query: string;
    view: ArchivedSessionView;
}) {
    const { t } = useTranslation();
    const selectedProject = view.projectOptions.find((project) => project.id === view.projectId);
    return (
        <div className="grid grid-cols-[minmax(220px,1fr)_minmax(160px,0.6fr)_minmax(150px,0.5fr)] gap-3 border-b border-border bg-background px-4 py-3">
            <label className="grid gap-1 text-[11px] text-muted" htmlFor="archived-search">
                {t('common.search')}
                <span className="relative block text-foreground">
                    <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted"
                        size={14}
                    />
                    <Input
                        autoFocus
                        id="archived-search"
                        className="pl-8"
                        placeholder={t('session.archived.searchPlaceholder')}
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                    />
                </span>
            </label>
            <label className="grid gap-1 text-[11px] text-muted" htmlFor="archived-project">
                {t('session.archived.projectFilter')}
                <Select
                    value={view.projectId}
                    onValueChange={(value) => onProjectChange(value ?? 'all')}
                >
                    <SelectTrigger
                        id="archived-project"
                        aria-label={t('session.archived.filterByProject')}
                    >
                        <SelectValue>
                            {selectedProject?.title ?? t('session.archived.allProjects')}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">{t('session.archived.allProjects')}</SelectItem>
                        {view.projectOptions.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                                {project.title}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </label>
            <label className="grid gap-1 text-[11px] text-muted" htmlFor="archived-agent">
                {t('session.archived.agentFilter')}
                <Select value={agent} onValueChange={(value) => onAgentChange(value ?? 'all')}>
                    <SelectTrigger
                        id="archived-agent"
                        aria-label={t('session.archived.filterByAgent')}
                    >
                        <SelectValue>
                            {agent === 'all'
                                ? t('session.archived.allAgents')
                                : resolveAgentIcon(agent).label}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">{t('session.archived.allAgents')}</SelectItem>
                        {view.agentOptions.map((kind) => (
                            <SelectItem key={kind} value={kind}>
                                {resolveAgentIcon(kind).label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </label>
        </div>
    );
}

function ArchivedSelectionToolbar({
    onClear,
    onDeleteSelected,
    onRestoreSelected,
    onToggle,
    selection,
    untitledIds,
    visibleIds,
}: {
    onClear: () => void;
    onDeleteSelected: () => void;
    onRestoreSelected: () => void;
    onToggle: ToggleSessions;
    selection: ReadonlySet<string>;
    untitledIds: readonly string[];
    visibleIds: readonly string[];
}) {
    const { t } = useTranslation();
    const isAllVisibleSelected = visibleIds.length > 0 && selection.size === visibleIds.length;
    const allUntitledSelected =
        untitledIds.length > 0 && untitledIds.every((sessionId) => selection.has(sessionId));
    return (
        <div className="archived-selection-toolbar mb-3 flex flex-wrap items-center gap-2">
            <label className="flex h-7 cursor-pointer items-center gap-2 text-[11px] text-muted">
                <Checkbox
                    aria-label={t('session.archived.selectAllVisible')}
                    checked={isAllVisibleSelected}
                    indeterminate={!isAllVisibleSelected && selection.size > 0}
                    onCheckedChange={(next) => onToggle(visibleIds, next === true)}
                />
                {t('session.archived.selectAll')}
            </label>
            <Button
                aria-pressed={allUntitledSelected}
                disabled={untitledIds.length === 0}
                size="sm"
                variant="ghost"
                onClick={() => onToggle(untitledIds, !allUntitledSelected)}
            >
                {t(
                    allUntitledSelected
                        ? 'session.archived.deselectUntitled'
                        : 'session.archived.selectUntitled',
                )}
                <span className="text-muted tabular-nums">{untitledIds.length}</span>
            </Button>
            {selection.size > 0 && (
                <>
                    <span className="ml-auto text-[11px] text-muted tabular-nums">
                        {t('session.archived.selectedCount', { count: selection.size })}
                    </span>
                    <Button size="sm" variant="secondary" onClick={onRestoreSelected}>
                        <ArchiveRestore aria-hidden="true" size={13} />
                        {t('session.archived.restoreSelected')}
                    </Button>
                    <Button
                        className="text-danger hover:text-danger"
                        size="sm"
                        variant="ghost"
                        onClick={onDeleteSelected}
                    >
                        <Trash2 aria-hidden="true" size={13} />
                        {t('session.archived.deleteSelected')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onClear}>
                        {t('common.clear')}
                    </Button>
                </>
            )}
        </div>
    );
}

function ArchivedSessionRow({
    isSelected,
    item,
    onToggle,
}: {
    isSelected: boolean;
    item: ArchivedSessionItem;
    onToggle: ToggleSessions;
}) {
    const { t } = useTranslation();
    return (
        <div
            aria-selected={isSelected}
            className="archived-manager-row grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 aria-selected:bg-[var(--selection)]"
            data-session-id={item.session.id}
        >
            <Checkbox
                aria-label={t('session.archived.selectSession', {
                    title: sessionTitleForDisplay(item.session.title, t),
                })}
                checked={isSelected}
                onCheckedChange={(next) => onToggle([item.session.id], next === true)}
            />
            <div className="flex min-w-0 items-center gap-2">
                <AgentIdentityIcon identity={item.agent} size={15} />
                <div className="min-w-0">
                    <p className="m-0 truncate text-[12px] font-medium">
                        {sessionTitleForDisplay(item.session.title, t)}
                    </p>
                    <p className="m-0 truncate text-[11px] text-muted">
                        {item.project.title}
                        {' · '}
                        {resolveAgentIcon(item.agent).label}
                        {' · '}
                        {t('session.archived.archivedAt', {
                            time: archivedTimestamp(item.archivedAt, t.locale),
                        })}
                    </p>
                </div>
            </div>
            <div className="flex gap-1">
                <Button
                    aria-label={t('session.archived.restoreSession', {
                        title: sessionTitleForDisplay(item.session.title, t),
                    })}
                    size="sm"
                    variant="secondary"
                    onClick={() => unarchiveSession(item.session.id)}
                >
                    <ArchiveRestore aria-hidden="true" size={13} />
                    {t('common.restore')}
                </Button>
                <Button
                    aria-label={t('session.archived.deleteSession', {
                        title: sessionTitleForDisplay(item.session.title, t),
                    })}
                    className="text-danger hover:text-danger"
                    size="sm"
                    variant="ghost"
                    onClick={() => deleteSession(item.session.id)}
                >
                    <Trash2 aria-hidden="true" size={13} />
                    {t('common.delete')}
                </Button>
            </div>
        </div>
    );
}

/**
 * An empty archive and an archive hidden by the current filters are different dead ends: only the second one is the
 * user's own doing, so only it offers a way back.
 */
function ArchivedEmptyState({
    isFiltered,
    onClearFilters,
}: {
    isFiltered: boolean;
    onClearFilters: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="grid min-h-48 place-items-center rounded border border-dashed border-border p-8 text-center">
            {isFiltered ? (
                <div>
                    <p className="m-0 text-[13px] font-medium">{t('session.archived.noMatches')}</p>
                    <Button className="mt-3" size="sm" variant="secondary" onClick={onClearFilters}>
                        {t('session.archived.clearFilters')}
                    </Button>
                </div>
            ) : (
                <div>
                    <Archive aria-hidden="true" className="mx-auto mb-3 text-muted" />
                    <p className="m-0 text-[13px] font-medium">
                        {t('session.archived.emptyTitle')}
                    </p>
                    <p className="mt-1 mb-0 text-[11px] text-muted">
                        {t('session.archived.emptyDescription')}
                    </p>
                </div>
            )}
        </div>
    );
}

function openSessionSearchFromArchive(): void {
    setArchivedSessionsOpen(false);
    setSessionSearchOpen(true);
}

function ArchivedSessionsDialogBody() {
    const { t } = useTranslation();
    const projects = useProjects() ?? NO_RECORDS;
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const [query, setQuery] = useState('');
    const [projectId, setProjectId] = useState('all');
    const [agent, setAgent] = useState<ArchivedSessionFilters['agent']>('all');
    const view = useMemo(
        () => deriveArchivedSessionView(projects, sessions, terminals, { agent, projectId, query }),
        [agent, projectId, projects, query, sessions, terminals],
    );
    const [rawSelection, setSelection] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
    /**
     * Pruned on every render instead of in an effect so a filter change and a bulk action in the same tick can never
     * observe a selection that still names hidden Sessions.
     */
    const selection = useMemo(
        () => pruneArchivedSelection(rawSelection, view),
        [rawSelection, view],
    );
    const visibleIds = useMemo(() => visibleArchivedSessionIds(view), [view]);
    const untitledIds = useMemo(() => untitledArchivedSessionIds(view), [view]);
    const clearFilters = (): void => {
        setQuery('');
        setProjectId('all');
        setAgent('all');
    };
    const toggleSessions: ToggleSessions = (sessionIds, isChecked) => {
        setSelection((previous) => {
            const next = new Set(previous);
            for (const sessionId of sessionIds)
                if (isChecked) next.add(sessionId);
                else next.delete(sessionId);
            return next;
        });
    };

    return (
        <>
            <DialogHeader>
                <DialogTitle>{t('session.archived.title')}</DialogTitle>
                <DialogDescription>{t('session.archived.description')}</DialogDescription>
            </DialogHeader>
            <ArchivedFilterBar
                agent={agent}
                query={query}
                view={view}
                onAgentChange={setAgent}
                onProjectChange={setProjectId}
                onQueryChange={setQuery}
            />
            <div className="archived-sessions-manager min-h-0 overflow-auto p-4">
                {view.matchingCount > 0 && (
                    <ArchivedSelectionToolbar
                        selection={selection}
                        untitledIds={untitledIds}
                        visibleIds={visibleIds}
                        onClear={() => setSelection(EMPTY_SELECTION)}
                        onDeleteSelected={() => {
                            // Selection survives a canceled native confirmation; a completed deletion prunes it via the refreshed view.
                            deleteSessions([...selection]);
                        }}
                        onRestoreSelected={() => {
                            unarchiveSessions([...selection]);
                            setSelection(EMPTY_SELECTION);
                        }}
                        onToggle={toggleSessions}
                    />
                )}
                {view.matchingCount === 0 ? (
                    <ArchivedEmptyState
                        isFiltered={view.totalCount > 0}
                        onClearFilters={clearFilters}
                    />
                ) : (
                    <div className="archived-session-list divide-y divide-border overflow-hidden rounded border border-border bg-background">
                        {view.items.map((item) => (
                            <ArchivedSessionRow
                                key={item.session.id}
                                isSelected={selection.has(item.session.id)}
                                item={item}
                                onToggle={toggleSessions}
                            />
                        ))}
                    </div>
                )}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
                <span className="text-[11px] text-muted" aria-live="polite">
                    {view.matchingCount === view.totalCount
                        ? t(
                              view.totalCount === 1
                                  ? 'session.archived.countOne'
                                  : 'session.archived.countOther',
                              { count: view.totalCount },
                          )
                        : t('session.archived.matchingCount', {
                              matching: view.matchingCount,
                              total: view.totalCount,
                          })}
                </span>
                <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={openSessionSearchFromArchive}>
                        <Search aria-hidden="true" size={12} />
                        {t('session.search.title')}
                    </Button>
                    <Button variant="secondary" onClick={() => setArchivedSessionsOpen(false)}>
                        {t('common.done')}
                    </Button>
                </div>
            </div>
        </>
    );
}
