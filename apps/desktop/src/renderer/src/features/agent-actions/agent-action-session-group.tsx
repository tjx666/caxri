import { ShortcutBadge } from '../../components/shortcut-badge';
import { CommandGroup, CommandItem } from '../../components/ui/command';
import type { SessionReferenceCandidate } from '../session/session-reference';

/**
 * The picker's `@` group: Sessions whose conversation the Agent can be pointed at. Choosing one inserts a reference to
 * a condensed copy of that conversation into the Agent's input without submitting it.
 */
export function AgentActionSessionGroup({
    candidates,
    onSelect,
}: {
    candidates: readonly SessionReferenceCandidate[];
    onSelect: (candidate: SessionReferenceCandidate) => void;
}) {
    if (candidates.length === 0) return null;
    return (
        <CommandGroup data-agent-action-group="session" heading="Sessions">
            {candidates.map((candidate) => (
                <CommandItem
                    key={candidate.sessionId}
                    data-session-reference={candidate.sessionId}
                    value={`session:${candidate.sessionId}`}
                    onSelect={() => onSelect(candidate)}
                >
                    <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                    {candidate.projectTitle && (
                        <small className="max-w-[40%] shrink-0 truncate text-[10px] text-muted">
                            {candidate.projectTitle}
                        </small>
                    )}
                </CommandItem>
            ))}
        </CommandGroup>
    );
}

/**
 * The footer's key hints. In `@` mode Enter inserts the Session reference and there is no separate run, so the
 * Command+Enter hint is dropped.
 */
export function AgentActionFooterModes({ isSessionMode }: { isSessionMode: boolean }) {
    return (
        <div className="flex items-center gap-3 text-[10px] text-muted">
            <span className="flex items-center gap-1" data-agent-action-mode="run">
                <ShortcutBadge compact shortcut="enter" /> {isSessionMode ? 'Insert' : 'Run'}
            </span>
            {!isSessionMode && (
                <span className="flex items-center gap-1" data-agent-action-mode="insert">
                    <ShortcutBadge compact shortcut="cmd+enter" /> Insert
                </span>
            )}
        </div>
    );
}
