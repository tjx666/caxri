import { useMemo } from 'react';

import { parseMarkdownBlocks } from '@caxri/markdown';
import type { AgentChatItem } from '@caxri/protocol';
import { CircleAlert } from 'lucide-react';

import { MarkdownBlocks } from '../../components/markdown-blocks';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';
import { agentChatNoticeMessage } from './agent-chat-presentation';

function openChatLink(url: string): void {
    // eslint-disable-next-line no-void -- openExternalUrl reports its own failures through the callback
    void openExternalUrl(url, (message) => pushToast('error', message));
}

export function AgentChatUserMessage({ text }: { text: string }) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[85%] rounded-lg bg-elevated px-3 py-2 text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap text-foreground">
                {text}
            </div>
        </div>
    );
}

/**
 * Agent reply rendered as Markdown. A streaming reply re-parses as it grows; the projection bounds every message, so
 * the parse stays small.
 */
export function AgentChatMessage({ text, className }: { text: string; className?: string }) {
    const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
    return (
        <div className={cn('space-y-2 text-[13px] leading-5 wrap-anywhere', className)}>
            <MarkdownBlocks blocks={blocks} onOpenUrl={openChatLink} />
        </div>
    );
}

export function AgentChatNotice({ item }: { item: Extract<AgentChatItem, { type: 'notice' }> }) {
    const isError = item.kind === 'error';
    return (
        <div
            className={cn(
                'flex items-start gap-2 text-[12px] leading-5',
                isError ? 'text-danger' : 'text-muted',
            )}
            role={isError ? 'alert' : undefined}
        >
            {isError && <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
            <span className="wrap-anywhere">{agentChatNoticeMessage(item)}</span>
        </div>
    );
}
