import { useEffect } from 'react';

import { Circle } from 'lucide-react';

import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import { useProjects, useSessions, useTerminals } from '../../stores/selectors';
import { sessionActivityPresentation } from '../sidebar/session-activity';
import { resolveSessionMruView, useSessionMruSwitcherStore } from './session-mru-switcher-state';

function useSessionMruSwitcherView() {
    const candidateIds = useSessionMruSwitcherStore((state) => state.candidateIds);
    const isOpen = useSessionMruSwitcherStore((state) => state.isOpen);
    const isVisible = useSessionMruSwitcherStore((state) => state.isVisible);
    const selectedIndex = useSessionMruSwitcherStore((state) => state.selectedIndex);
    const projects = useProjects() ?? [];
    const sessions = useSessions() ?? [];
    const terminals = useTerminals();
    return { candidateIds, isOpen, isVisible, projects, selectedIndex, sessions, terminals };
}

export function SessionMruSwitcher() {
    const view = useSessionMruSwitcherView();
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
    useEffect(() => {
        if (!selected && view.isOpen) useSessionMruSwitcherStore.getState().cancel();
    }, [selected, view.isOpen]);
    if (!selected || !view.isOpen || !view.isVisible) return null;
    return (
        <div className="pointer-events-none fixed inset-0 z-[60] grid place-items-center">
            <p className="sr-only" aria-atomic="true" aria-live="assertive" role="status">
                {`Selected ${selected.displayTitle}, ${selectedIndex + 1} of ${candidates.length}`}
            </p>
            <div
                className="session-mru-switcher motion-safe:animate-in fade-in-0 zoom-in-95 w-[min(520px,calc(100vw-40px))] overflow-hidden rounded-lg border border-border bg-surface shadow-[0_16px_48px_var(--shadow)]"
                aria-activedescendant={`session-mru-option-${selected.id}`}
                aria-label="Recently used Sessions"
                role="listbox"
            >
                <div className="border-b border-border px-3 py-2 text-[11px] font-medium text-muted">
                    Recently used Sessions
                </div>
                <div className="max-h-[min(420px,60vh)] overflow-y-auto p-1">
                    {candidates.map((session, index) => {
                        const project = projects.find((item) => item.id === session.projectId);
                        const terminal =
                            terminals.find((item) => item.id === session.primaryAgentTerminalId) ??
                            terminals.find((item) => item.sessionId === session.id);
                        const activity = sessionActivityPresentation(session.lastActivityState);
                        return (
                            <div
                                key={session.id}
                                id={`session-mru-option-${session.id}`}
                                className={cn(
                                    'flex min-h-10 items-center gap-2 rounded px-2 py-1.5 text-foreground',
                                    index === selectedIndex && 'bg-elevated',
                                )}
                                aria-selected={index === selectedIndex}
                                data-session-id={session.id}
                                role="option"
                            >
                                <span
                                    className={cn(
                                        'flex size-3 flex-none items-center justify-center',
                                        activity.indicatorClassName,
                                    )}
                                    aria-label={activity.ariaLabel}
                                    role="img"
                                >
                                    <Circle size={6} fill="currentColor" />
                                </span>
                                <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={16} />
                                <span className="min-w-0 flex-1">
                                    <strong className="block truncate text-[13px] font-medium">
                                        {session.displayTitle}
                                    </strong>
                                    <span className="block truncate text-[11px] text-muted">
                                        {project?.displayTitle ?? 'Unknown Project'}
                                    </span>
                                </span>
                                {session.hasUnread && (
                                    <span
                                        className="size-1.5 flex-none rounded-full bg-warning"
                                        aria-label="Unread"
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
