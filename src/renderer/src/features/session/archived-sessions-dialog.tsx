import { Archive, ArchiveRestore, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

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
import { Button } from '../../components/ui/button';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { setArchivedSessionsOpen, useDialogStore } from '../../stores/dialogs';
import { useProjects, useSessions, useTerminals } from '../../stores/selectors';
import { deleteSession, unarchiveSession } from './session-actions';
import { deriveArchivedSessionView, type ArchivedSessionFilters } from './archived-sessions';

const NO_RECORDS: never[] = [];
const archivedTimestampFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

function archivedTimestamp(value: number): string {
    return archivedTimestampFormatter.format(value);
}

export function ArchivedSessionsDialog() {
    const open = useDialogStore((state) => state.archivedSessionsOpen);
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
    const selectedProject = view.projectOptions.find((project) => project.id === view.projectId);
    const agentLabel = agent === 'all' ? 'All Agents' : resolveAgentIcon(agent).label;
    const clearFilters = (): void => {
        setQuery('');
        setProjectId('all');
        setAgent('all');
    };
    const setOpen = (nextOpen: boolean): void => {
        if (!nextOpen) clearFilters();
        setArchivedSessionsOpen(nextOpen);
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
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
                                return (
                                    <section
                                        key={group.project.id}
                                        aria-labelledby={headingId}
                                        className="archived-project-group overflow-hidden rounded border border-border bg-background"
                                        data-project-id={group.project.id}
                                    >
                                        <header className="flex h-9 items-center gap-2 border-b border-border bg-surface px-3">
                                            <h2
                                                id={headingId}
                                                className="m-0 min-w-0 flex-1 truncate text-[12px] font-semibold"
                                            >
                                                {group.project.displayTitle}
                                            </h2>
                                            <span className="text-[10px] tabular-nums text-muted">
                                                {group.sessions.length}
                                            </span>
                                        </header>
                                        <div className="divide-y divide-border">
                                            {group.sessions.map((item) => (
                                                <div
                                                    key={item.session.id}
                                                    className="archived-manager-row grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2"
                                                    data-session-id={item.session.id}
                                                >
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
