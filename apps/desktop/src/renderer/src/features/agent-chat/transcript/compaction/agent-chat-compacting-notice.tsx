import { FoldVertical } from 'lucide-react';

import { useTranslation } from '../../../../i18n';
import { AgentChatElapsedTime } from '../../activity/agent-chat-rolling-time';

/**
 * Holds the place of a compaction while it runs, at the end of the timeline where the eye rests after sending, so a
 * long compaction never leaves a blank page under the last message. It wears the same divider as the
 * `AgentChatCompactedNotice` that replaces it once the provider records the boundary, with how long it has run, and,
 * when the last message is still unanswered, says the Agent reads it once the compaction ends. The composer's status
 * line owns the live region, so this row stays a plain note.
 */
export function AgentChatCompactingNotice({
    isAfterUserMessage,
    startedAt,
}: {
    isAfterUserMessage: boolean;
    startedAt: number | undefined;
}) {
    const { t } = useTranslation();
    return (
        <div
            className="flex flex-col items-center gap-1 py-1 text-[12px] leading-5 text-muted"
            data-agent-chat-compacting=""
            role="note"
        >
            <div className="flex w-full items-center gap-3">
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
                <span className="flex shrink-0 items-center gap-1.5">
                    <FoldVertical aria-hidden="true" className="size-3.5" />
                    <span className="activity-shimmer">{t('agentChat.timeline.compacting')}</span>
                    {startedAt !== undefined && <AgentChatElapsedTime startedAt={startedAt} />}
                </span>
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
            </div>
            {isAfterUserMessage && <span>{t('agentChat.message.compactingBeforeReply')}</span>}
        </div>
    );
}
