import { useMemo, useState } from 'react';

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
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { setArchivedSessionsOpen, useDialogStore } from '../../stores/dialogs';
import { useProjects, useSessions, useTerminals } from '../../stores/selectors';
import type { ArchivedSessionFilters } from './archived-sessions';
import {
    deriveArchivedSessionView,
    pruneArchivedSelection,
    untitledArchivedSessionIds,
    visibleArchivedSessionIds,
} from './archived-sessions';
import {
    deleteSession,
    deleteSessions,
    unarchiveSession,
    unarchiveSessions,
} from './session-actions';

const NO_RECORDS: never[] = [];
const EMPTY_SELECTION: ReadonlySet<string> = new Set();
const archivedTimestampFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

function archivedTimestamp(value: number): string {
    return archivedTimestampFormatter.format(value);
}

export function ArchivedSessionsDialog() {
    const isOpen = useDialogStore((state) => state.archivedSessionsOpen);
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
    const selectedProject = view.projectOptions.find((project) => project.id === view.projectId);
    const agentLabel = agent === 'all' ? 'All Agents' : resolveAgentIcon(agent).label;
    const clearFilters = (): void => {
        setQuery('');
        setProjectId('all');
        setAgent('all');
    };
    const setOpen = (isNextOpen: boolean): void => {
        if (!isNextOpen) {
            clearFilters();
            setSelection(EMPTY_SELECTION);
        }
        setArchivedSessionsOpen(isNextOpen);
    };
    const toggleSessions = (sessionIds: readonly string[], isChecked: boolean): void => {
        setSelection((previous) => {
            const next = new Set(previous);
            for (const sessionId of sessionIds)
                if (isChecked) next.add(sessionId);
                else next.delete(sessionId);
            return next;
        });
    };
    const isAllVisibleSelected = visibleIds.length > 0 && selection.size === visibleIds.length;
    const allUntitledSelected =
        untitledIds.length > 0 && untitledIds.every((sessionId) => selection.has(sessionId));
    const selectedIds = [...selection];
    const restoreSelected = (): void => {
        unarchiveSessions(selectedIds);
        setSelection(EMPTY_SELECTION);
    };
    const deleteSelected = (): void => {
        // Selection survives a canceled native confirmation; a completed deletion prunes it via the refreshed view.
        deleteSessions(selectedIds);
    };

    return (
        <Dialog open={isOpen} onOpenChange={setOpen}>
            <DialogContent className="grid h-[min(760px,calc(100vh-48px))] w-[min(980px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Archived Sessions</DialogTitle>
                    <DialogDescription>
                        Search and manage archived work across every Project. Restoring a Session
                        does not start its Terminal.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-[minmax(220px,1fr)_minmax(160px,0.6fr)_minmax(150px,0.5fr)] gap-3 border-b border-border bg-background px-4 py-3">
                    <label className="grid gap-1 text-[11px] text-muted" htmlFor="archived-search">
                        Search
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
                                placeholder="Search Session titles"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                        </span>
                    </label>
                    <label className="grid gap-1 text-[11px] text-muted" htmlFor="archived-project">
                        Project
                        <Select
                            value={view.projectId}
                            onValueChange={(value) => setProjectId(value ?? 'all')}
                        >
                            <SelectTrigger id="archived-project" aria-label="Filter by Project">
                                <SelectValue>
                                    {selectedProject?.displayTitle ?? 'All Projects'}
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Projects</SelectItem>
                                {view.projectOptions.map((project) => (
                                    <SelectItem key={project.id} value={project.id}>
                                        {project.displayTitle}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </label>
                    <label className="grid gap-1 text-[11px] text-muted" htmlFor="archived-agent">
                        Agent
                        <Select value={agent} onValueChange={(value) => setAgent(value ?? 'all')}>
                            <SelectTrigger id="archived-agent" aria-label="Filter by Agent">
                                <SelectValue>{agentLabel}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Agents</SelectItem>
                                {view.agentOptions.map((kind) => (
                                    <SelectItem key={kind} value={kind}>
                                        {resolveAgentIcon(kind).label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </label>
                </div>
                <div className="archived-sessions-manager min-h-0 overflow-auto p-4">
                    {view.matchingCount > 0 && (
                        <div className="archived-selection-toolbar mb-3 flex flex-wrap items-center gap-2">
                            <label className="flex h-7 cursor-pointer items-center gap-2 text-[11px] text-muted">
                                <Checkbox
                                    aria-label="Select all visible archived Sessions"
                                    checked={isAllVisibleSelected}
                                    indeterminate={!isAllVisibleSelected && selection.size > 0}
                                    onCheckedChange={(next) =>
                                        toggleSessions(visibleIds, next === true)
                                    }
                                />
                                Select all
                            </label>
                            <Button
                                aria-pressed={allUntitledSelected}
                                disabled={untitledIds.length === 0}
                                size="sm"
                                variant="ghost"
                                onClick={() => toggleSessions(untitledIds, !allUntitledSelected)}
                            >
                                {allUntitledSelected ? 'Deselect Untitled' : 'Select Untitled'}
                                <span className="text-muted tabular-nums">
                                    {untitledIds.length}
                                </span>
                            </Button>
                            {selection.size > 0 && (
                                <>
                                    <span className="ml-auto text-[11px] text-muted tabular-nums">
                                        {selection.size} selected
                                    </span>
                                    <Button size="sm" variant="secondary" onClick={restoreSelected}>
                                        <ArchiveRestore aria-hidden="true" size={13} />
                                        Restore Selected
                                    </Button>
                                    <Button
                                        className="text-danger hover:text-danger"
                                        size="sm"
                                        variant="ghost"
                                        onClick={deleteSelected}
                                    >
                                        <Trash2 aria-hidden="true" size={13} />
                                        Delete Selected
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => setSelection(EMPTY_SELECTION)}
                                    >
                                        Clear
                                    </Button>
                                </>
                            )}
                        </div>
                    )}
                    {view.totalCount === 0 ? (
                        <div className="grid min-h-48 place-items-center rounded border border-dashed border-border p-8 text-center">
                            <div>
                                <Archive aria-hidden="true" className="mx-auto mb-3 text-muted" />
                                <p className="m-0 text-[13px] font-medium">
                                    No archived Sessions yet
                                </p>
                                <p className="mt-1 mb-0 text-[11px] text-muted">
                                    Archived Sessions will remain available here for restoration or
                                    deletion.
                                </p>
                            </div>
                        </div>
                    ) : view.matchingCount === 0 ? (
                        <div className="grid min-h-48 place-items-center rounded border border-dashed border-border p-8 text-center">
                            <div>
                                <p className="m-0 text-[13px] font-medium">
                                    No archived Sessions match these filters
                                </p>
                                <Button
                                    className="mt-3"
                                    size="sm"
                                    variant="secondary"
                                    onClick={clearFilters}
                                >
                                    Clear Filters
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="grid gap-4">
                            {view.groups.map((group) => {
                                const headingId = `archived-project-${group.project.id}`;
                                const groupIds = group.sessions.map((item) => item.session.id);
                                const groupSelectedCount = groupIds.filter((sessionId) =>
                                    selection.has(sessionId),
                                ).length;
                                const isGroupSelected = groupSelectedCount === groupIds.length;
                                return (
                                    <section
                                        key={group.project.id}
                                        aria-labelledby={headingId}
                                        className="archived-project-group overflow-hidden rounded border border-border bg-background"
                                        data-project-id={group.project.id}
                                    >
                                        <header className="flex h-9 items-center gap-2 border-b border-border bg-surface px-3">
                                            <Checkbox
                                                aria-label={`Select all archived Sessions in ${group.project.displayTitle}`}
                                                checked={isGroupSelected}
                                                indeterminate={
                                                    !isGroupSelected && groupSelectedCount > 0
                                                }
                                                onCheckedChange={(next) =>
                                                    toggleSessions(groupIds, next === true)
                                                }
                                            />
                                            <h2
                                                id={headingId}
                                                className="m-0 min-w-0 flex-1 truncate text-[12px] font-semibold"
                                            >
                                                {group.project.displayTitle}
                                            </h2>
                                            <span className="text-[10px] text-muted tabular-nums">
                                                {group.sessions.length}
                                            </span>
                                        </header>
                                        <div className="divide-y divide-border">
                                            {group.sessions.map((item) => (
                                                <div
                                                    key={item.session.id}
                                                    aria-selected={selection.has(item.session.id)}
                                                    className="archived-manager-row grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 aria-selected:bg-[var(--selection)]"
                                                    data-session-id={item.session.id}
                                                >
                                                    <Checkbox
                                                        aria-label={`Select ${item.session.displayTitle}`}
                                                        checked={selection.has(item.session.id)}
                                                        onCheckedChange={(next) =>
                                                            toggleSessions(
                                                                [item.session.id],
                                                                next === true,
                                                            )
                                                        }
                                                    />
                                                    <div className="flex min-w-0 items-center gap-2">
                                                        <AgentIdentityIcon
                                                            identity={item.agent}
                                                            size={15}
                                                        />
                                                        <div className="min-w-0">
                                                            <p className="m-0 truncate text-[12px] font-medium">
                                                                {item.session.displayTitle}
                                                            </p>
                                                            <p className="m-0 text-[10px] text-muted">
                                                                {resolveAgentIcon(item.agent).label}
                                                                {' · '}
                                                                Archived{' '}
                                                                {archivedTimestamp(item.archivedAt)}
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="flex gap-1">
                                                        <Button
                                                            aria-label={`Restore ${item.session.displayTitle}`}
                                                            size="sm"
                                                            variant="secondary"
                                                            onClick={() =>
                                                                unarchiveSession(item.session.id)
                                                            }
                                                        >
                                                            <ArchiveRestore
                                                                aria-hidden="true"
                                                                size={13}
                                                            />
                                                            Restore
                                                        </Button>
                                                        <Button
                                                            aria-label={`Delete ${item.session.displayTitle}`}
                                                            className="text-danger hover:text-danger"
                                                            size="sm"
                                                            variant="ghost"
                                                            onClick={() =>
                                                                deleteSession(item.session.id)
                                                            }
                                                        >
                                                            <Trash2 aria-hidden="true" size={13} />
                                                            Delete
                                                        </Button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </section>
                                );
                            })}
                        </div>
                    )}
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
                    <span className="text-[11px] text-muted" aria-live="polite">
                        {view.matchingCount === view.totalCount
                            ? `${view.totalCount} archived ${view.totalCount === 1 ? 'Session' : 'Sessions'}`
                            : `${view.matchingCount} of ${view.totalCount} archived Sessions`}
                    </span>
                    <Button variant="secondary" onClick={() => setOpen(false)}>
                        Done
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
