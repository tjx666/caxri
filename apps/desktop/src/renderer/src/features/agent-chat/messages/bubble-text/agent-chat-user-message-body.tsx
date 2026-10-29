import type { ReactNode } from 'react';
import { Fragment } from 'react';

import { WebLink } from '../../../../components/markdown/web-link';
import { Tooltip } from '../../../../components/ui/tooltip';
import { useTranslation } from '../../../../i18n';
import { linkSummary } from '../../../../lib/link-summary';
import { cn } from '../../../../lib/utilities';
import {
    AgentChatImagePill,
    AgentChatLongPastePill,
    AgentChatPathPill,
    AgentChatSessionReferencePill,
} from '../../attachments/agent-chat-image-pill';
import { useAgentChatTerminal } from '../../hooks/use-agent-chat-terminal';
import { openAgentChatLink } from '../../transcript/agent-chat-links';
import type { AgentChatUserMessageSegment } from '../agent-chat-user-message-text';
import { agentChatUserMessageSegments } from '../agent-chat-user-message-text';
import type {
    AgentChatUserMessageRun,
    AgentChatUserMessageStyle,
} from './agent-chat-user-message-blocks';
import { agentChatUserMessageBlocks } from './agent-chat-user-message-blocks';

/**
 * The composer's live-preview tokens (`composerTheme` in `agent-chat-composer-extensions.ts`) as utilities, so a sent
 * message looks like the draft it was written as.
 */
const STYLE_CLASSES: Record<AgentChatUserMessageStyle, string> = {
    code: "rounded-sm bg-[color-mix(in_srgb,var(--border)_45%,transparent)] py-px font-[family-name:var(--editor-font-family,ui-monospace,'Caxri_JetBrains_Mono',monospace)] text-[12px]",
    emphasis: 'italic',
    strike: 'line-through',
    strong: 'font-semibold',
    syntax: 'text-muted',
};

function styleClass(styles: readonly AgentChatUserMessageStyle[]): string | undefined {
    return styles.length === 0 ? undefined : cn(styles.map((style) => STYLE_CLASSES[style]));
}

/**
 * The user's own words as the composer showed them: bold, italics, inline code, lists, and quotes render with their
 * markers hidden (`agentChatUserMessageBlocks`), and the text itself is unchanged, so Copy and Edit still take the
 * original. A path they typed or dropped in (`src/app.ts:12`, an absolute path) opens in the editor, and a URL they
 * pasted gets the same site icon and hover card as a link in a reply. Both take the reply's link treatment (the full
 * accent with no underline until hover), so a link reads the same on both sides of the transcript. An image's
 * placeholder reads as the pill it was in the composer.
 */
export function AgentChatUserMessageBody({
    images,
    text,
    onOpenFile,
}: {
    images: ReadonlyArray<{ thumbnail?: string }> | undefined;
    text: string;
    onOpenFile?: (target: string) => void;
}) {
    const terminalId = useAgentChatTerminal();
    const { t } = useTranslation();
    const segments = agentChatUserMessageSegments(text, {
        withFiles: onOpenFile !== undefined,
        imageCount: images?.length,
    });
    const renderSegment = (
        segment: Exclude<AgentChatUserMessageSegment, { kind: 'text' }>,
        position: number,
    ): ReactNode => {
        if (segment.kind === 'image')
            return (
                <AgentChatImagePill
                    key={position}
                    number={segment.number}
                    thumbnail={images?.[segment.index]?.thumbnail}
                />
            );
        if (segment.kind === 'session')
            return (
                <AgentChatSessionReferencePill
                    key={position}
                    path={segment.path}
                    title={segment.title}
                />
            );
        if (segment.kind === 'paste')
            return (
                <AgentChatLongPastePill
                    characterCount={segment.characterCount}
                    key={position}
                    lineCount={segment.lineCount}
                    path={segment.path}
                    onOpen={onOpenFile}
                />
            );
        if (segment.kind === 'path')
            return (
                <AgentChatPathPill
                    isDirectory={segment.isDirectory}
                    key={position}
                    onOpen={onOpenFile}
                    path={segment.path}
                />
            );
        if (segment.kind === 'file')
            /*
             * An anchor rather than a `<button>`: a button is an atomic inline block, so a long path that does not fit the
             * line moves whole to the next one and leaves the quotes around it on lines of their own, while an anchor
             * wraps with the surrounding text. Main denies every window navigation, so `href` is semantic only (it makes
             * the anchor focusable and Enter-activated); the click opens the file instead.
             */
            return (
                <Tooltip
                    content={t('agentChat.timeline.openNamed', { name: segment.file })}
                    key={position}
                >
                    <a
                        className="cursor-pointer text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                        href={segment.file}
                        onClick={(event) => {
                            event.preventDefault();
                            onOpenFile?.(segment.file);
                        }}
                    >
                        {segment.text}
                    </a>
                </Tooltip>
            );
        const summary = linkSummary(segment.url);
        if (!summary) return segment.text;
        return (
            <WebLink
                className="text-accent hover:underline"
                href={segment.url}
                key={position}
                referenceTerminalId={terminalId}
                // The message's hover action row sits right under the bubble; a card opening below would cover it.
                side="top"
                summary={summary}
                onOpen={openAgentChatLink}
            >
                {segment.text}
            </WebLink>
        );
    };
    const renderRun = (run: AgentChatUserMessageRun, position: number): ReactNode => {
        if (run.kind === 'bullet')
            return (
                <span className="text-[15px] leading-none text-muted" key={position}>
                    •
                </span>
            );
        const className = run.styles.length > 0 ? styleClass(run.styles) : undefined;
        const content = run.kind === 'text' ? run.text : renderSegment(run.segment, position);
        // An unstyled run adds no element, so a link stays the sibling of the text before it and wraps with it.
        return className ? (
            <span className={className} key={position}>
                {content}
            </span>
        ) : (
            <Fragment key={position}>{content}</Fragment>
        );
    };
    return agentChatUserMessageBlocks(text, segments).map((block, position) => {
        const runs = block.runs.map((run, index) => renderRun(run, index));
        if (!block.line) return <Fragment key={position}>{runs}</Fragment>;
        return (
            <div
                className={cn(
                    block.line === 'quote' &&
                        'my-0.5 border-l-[3px] border-[var(--selection)] pl-2 text-muted',
                )}
                key={position}
                style={
                    block.indent
                        ? { paddingLeft: `${block.indent}ch`, textIndent: `-${block.indent}ch` }
                        : undefined
                }
            >
                {runs}
            </div>
        );
    });
}
