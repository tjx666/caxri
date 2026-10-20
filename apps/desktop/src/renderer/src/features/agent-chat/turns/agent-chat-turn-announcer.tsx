import { useState } from 'react';

import type { AgentChatTurn } from '@caxri/protocol';

import type { TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import type { AgentChatTurnAnnouncement } from './agent-chat-turn-announcement';
import { agentChatTurnAnnouncement } from './agent-chat-turn-announcement';

const ANNOUNCEMENT_KEYS: Record<AgentChatTurnAnnouncement, TranslationKey> = {
    'Reply ready': 'agentChat.timeline.announcement.replyReady',
    'Turn failed': 'agentChat.timeline.announcement.turnFailed',
    'Stopped': 'agentChat.timeline.announcement.stopped',
};

/**
 * A polite live region that tells a screen reader user how the turn they were waiting on ended, since the reply lands
 * far from the composer they are focused in. The turn is remembered when it stops being active and announced once the
 * projection records its final status (the two can arrive in separate patches); a new turn clears the region so the
 * same words announce again next time.
 */
export function AgentChatTurnAnnouncer({
    activeTurnId,
    turns,
}: {
    activeTurnId: string | undefined;
    turns: readonly AgentChatTurn[] | undefined;
}) {
    const [watchedTurnId, setWatchedTurnId] = useState(activeTurnId);
    const [endedTurnId, setEndedTurnId] = useState<string | undefined>();
    const { t } = useTranslation();
    const [message, setMessage] = useState<AgentChatTurnAnnouncement | ''>('');
    if (activeTurnId !== watchedTurnId) {
        setWatchedTurnId(activeTurnId);
        setEndedTurnId(watchedTurnId);
        if (activeTurnId !== undefined) setMessage('');
    }
    const announcement = agentChatTurnAnnouncement(endedTurnId, turns);
    if (announcement !== undefined) {
        setEndedTurnId(undefined);
        setMessage(announcement);
    }
    return (
        <div aria-live="polite" className="sr-only" role="status">
            {message && t(ANNOUNCEMENT_KEYS[message])}
        </div>
    );
}
