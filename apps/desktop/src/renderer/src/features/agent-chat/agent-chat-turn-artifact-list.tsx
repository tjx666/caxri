import type { AgentChatTurnArtifacts } from '@caxri/protocol';

import { AgentChatTrackerCard } from './agent-chat-tracker-card';
import { AgentChatTurnChanges } from './agent-chat-turn-changes';

/**
 * What a finished turn left behind, under its reply: the changed files first, then each issue or pull request it
 * created or edited.
 */
export function AgentChatTurnArtifactList({ artifacts }: { artifacts: AgentChatTurnArtifacts }) {
    return (
        <div className="mt-3 flex flex-col gap-2">
            {artifacts.files.length > 0 && (
                <AgentChatTurnChanges
                    files={artifacts.files}
                    isPartial={artifacts.isPartial === true}
                    turnId={artifacts.turnId}
                />
            )}
            {artifacts.trackers.map((artifact) => (
                <AgentChatTrackerCard artifact={artifact} key={artifact.url} />
            ))}
        </div>
    );
}
