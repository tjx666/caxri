import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { AgentChatSnapshot } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { AgentChatMessageImages } from './agent-chat-message-images';
import { AgentChatMessageVideos } from './agent-chat-message-videos';
import { agentChatImageCounts } from './agent-chat-model';
import { agentChatVideoPaths } from './agent-chat-videos';

/**
 * Renders what a user message carries above its text: its images and the videos it cites. Keyed on the messages that
 * carry them, not the snapshot, so a streamed reply does not redraw every entry.
 */
export const useAgentChatMessageAttachments = (
    snapshot: Pick<AgentChatSnapshot, 'items' | 'terminalId'> | undefined,
    theme: MobileTheme,
) => {
    const imageCounts = agentChatImageCounts(snapshot);
    const videoPaths = agentChatVideoPaths(snapshot);
    const terminalId = snapshot?.terminalId;
    return useMemo(() => {
        const counts = new Map<string, number>(
            imageCounts ? (JSON.parse(imageCounts) as Array<[string, number]>) : [],
        );
        const videos = new Map<string, string[]>(
            videoPaths ? (JSON.parse(videoPaths) as Array<[string, string[]]>) : [],
        );
        return (itemId: string): ReactNode => {
            const count = counts.get(itemId);
            const paths = videos.get(itemId);
            if (!terminalId || (!count && !paths)) return null;
            return (
                <>
                    {count ? (
                        <AgentChatMessageImages
                            count={count}
                            itemId={itemId}
                            terminalId={terminalId}
                            theme={theme}
                        />
                    ) : null}
                    {paths ? (
                        <AgentChatMessageVideos
                            itemId={itemId}
                            paths={paths}
                            terminalId={terminalId}
                            theme={theme}
                        />
                    ) : null}
                </>
            );
        };
    }, [imageCounts, terminalId, theme, videoPaths]);
};
