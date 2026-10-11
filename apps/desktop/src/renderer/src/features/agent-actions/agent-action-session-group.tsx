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
