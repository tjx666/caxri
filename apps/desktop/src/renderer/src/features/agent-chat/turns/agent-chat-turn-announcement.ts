import type { AgentChatTurn } from '@caxri/protocol';

export type AgentChatTurnAnnouncement = 'Reply ready' | 'Turn failed' | 'Stopped';

/**
 * What a screen reader hears when the turn it was waiting on ends: the turn that was active (`endedTurnId`) is looked
 * up by id in the current turns and its final status named. `undefined` while that turn still runs or when the
 * projection no longer lists it, so a Chat opened on finished history announces nothing.
 */
export function agentChatTurnAnnouncement(
    endedTurnId: string | undefined,
    turns: ReadonlyArray<Pick<AgentChatTurn, 'id' | 'status'>> | undefined,
): AgentChatTurnAnnouncement | undefined {
    if (endedTurnId === undefined) return undefined;
    switch (turns?.find((turn) => turn.id === endedTurnId)?.status) {
        case 'completed': {
            return 'Reply ready';
        }
        case 'failed': {
            return 'Turn failed';
        }
        case 'interrupted': {
            return 'Stopped';
        }
        default: {
            return undefined;
        }
    }
}
