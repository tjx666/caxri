import { useState } from 'react';

import { agentChatMediaUrl } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { FileText, ImageIcon, MessageCircle } from 'lucide-react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { resolveFileIcon } from '../../../icons/files/file-icon-resolver';
import { cn } from '../../../lib/utilities';
import { useCaxriQuery } from '../../../queries/client';
import { useProjectById, useSessionById, useTerminal } from '../../../stores/selectors';
import { sessionReferenceProjectTitle } from '../../session/session-reference';
import { agentChatLongPasteChipText } from '../composer-input/agent-chat-long-paste';
import { useAgentChatTerminal } from '../hooks/use-agent-chat-terminal';
import { AgentChatVideoPlayerDialog } from './agent-chat-message-videos';
import { isAgentChatPlayableVideo, isPathInsideProject } from './agent-chat-path-pills';

/**
 * The inline pills a sent message draws where the composer drew them while it was written.
 */
const PILL_CLASS_NAME =
    'mx-px inline-flex h-4.5 items-center gap-1 rounded-sm bg-border/45 pr-1.5 pl-0.5 align-text-bottom text-[12px] leading-4.5 whitespace-nowrap';

/**
 * An image's `[Image #N]` placeholder in a sent message, drawn as the pill the composer showed while it was written:
 * the image's thumbnail and its name. A message read back from history may have no thumbnail; the pill then shows an
 * image icon. The tiles above the bubble preview the image, so the pill only marks where it sits in the text.
 */
export function AgentChatImagePill({
    number,
    thumbnail,
}: {
    number: number;
    thumbnail: string | undefined;
}) {
    const { t } = useTranslation();
    return (
        <span className={PILL_CLASS_NAME} data-agent-chat-image-pill={number}>
            {thumbnail ? (
                <img alt="" className="size-3.5 rounded-xs object-cover" src={thumbnail} />
            ) : (
                <ImageIcon aria-hidden="true" className="size-3.5 text-muted" />
            )}
            {t('agentChat.attachments.imageNumber', { number })}
        </span>
    );
}

/**
 * Whether a sent message's path names a folder. A path the composer wrote for a dropped folder ends in `/`; one the
 * user typed or pasted does not, so for a path inside the Session's Project the Server says what it names.
 */
function useIsFolderPath(path: string, hasTrailingSlash: boolean): boolean {
    const session = useSessionById(useTerminal(useAgentChatTerminal() ?? '')?.sessionId);
    const projectRoot = useProjectById(session?.projectId)?.rootPath;
    const { data: kind } = useCaxriQuery(
        'files.resolveKind',
        { sessionId: session?.id ?? '', path },
        {
            enabled:
                !hasTrailingSlash &&
                session !== undefined &&
                isPathInsideProject(path, projectRoot),
            retry: false,
            staleTime: Infinity,
        },
    );
    return hasTrailingSlash || kind === 'directory';
}

/**
 * An absolute path in a sent message, drawn as the pill the composer showed while it was written: the entry's file-type
 * icon and name, with the full path on hover. When the Chat can open files the pill opens it; it is an anchor so a pill
 * at the end of a line wraps with the text around it, as the file links beside it do. A video's pill shows its poster
 * frame instead and plays it (`VideoPathPill`).
 */
export function AgentChatPathPill({
    isDirectory,
    onOpen,
    path,
}: {
    isDirectory: boolean;
    onOpen: ((path: string) => void) | undefined;
    path: string;
}) {
    const name = pathBasename(path) || path;
    const isFolder = useIsFolderPath(path, isDirectory);
    if (!isDirectory && isAgentChatPlayableVideo(path))
        return <VideoPathPill name={name} path={path} />;
    const content = (
        <>
            <img
                alt=""
                className="size-3.5 shrink-0"
                src={resolveFileIcon({ kind: isFolder ? 'directory' : 'file', name }).src}
            />
            {name}
        </>
    );
    return (
        <Tooltip content={path}>
            {onOpen ? (
                <a
                    className={`${PILL_CLASS_NAME} cursor-pointer text-foreground no-underline hover:bg-border/75 focus-visible:outline focus-visible:outline-accent`}
                    data-agent-chat-path-pill={path}
                    href={path}
                    onClick={(event) => {
                        // Main denies every window navigation; `href` only makes the pill focusable and Enter-activated.
                        event.preventDefault();
                        onOpen(path);
                    }}
                >
                    {content}
                </a>
            ) : (
                <span className={PILL_CLASS_NAME} data-agent-chat-path-pill={path}>
                    {content}
                </span>
            )}
        </Tooltip>
    );
}

/**
 * A video's path in a sent message: the pill the composer showed, its poster frame and name, which plays the video
 * rather than opening it in the editor, as the tile under the message does (`AgentChatMessageVideos`).
 */
function VideoPathPill({ name, path }: { name: string; path: string }) {
    const { t } = useTranslation();
    const [isPlaying, setPlaying] = useState(false);
    const [hasPoster, setHasPoster] = useState(true);
    return (
        <>
            <Tooltip content={path}>
                <button
                    aria-label={t('agentChat.message.playVideo', { name })}
                    className={`${PILL_CLASS_NAME} cursor-pointer border-0 text-foreground hover:bg-border/75 focus-visible:outline focus-visible:outline-accent`}
                    data-agent-chat-path-pill={path}
                    type="button"
                    onClick={() => setPlaying(true)}
                >
                    <img
                        alt=""
                        className="size-3.5 shrink-0 rounded-xs object-cover"
                        src={
                            hasPoster
                                ? agentChatMediaUrl('poster', path)
                                : resolveFileIcon({ kind: 'file', name }).src
                        }
                        onError={() => setHasPoster(false)}
                    />
                    {name}
                </button>
            </Tooltip>
            <AgentChatVideoPlayerDialog
                path={isPlaying ? path : undefined}
                onClose={() => setPlaying(false)}
            />
        </>
    );
}

/**
 * A cited Session in a sent message, drawn as the chip the composer showed while it was written: the Session glyph,
 * `@`, and its title, never the reference file or the sentence the Agent received. A long title is cut with an
 * ellipsis; the tooltip has the whole title and, when this window cited it, its Project.
 */
export function AgentChatSessionReferencePill({ path, title }: { path: string; title: string }) {
    const { t } = useTranslation();
    const project = sessionReferenceProjectTitle(path);
    return (
        <Tooltip
            content={
                project ? t('agentChat.sessionReference.inProject', { project, title }) : title
            }
        >
            <span
                aria-label={t('agentChat.sessionReference.label', { title })}
                className={cn(PILL_CLASS_NAME, 'max-w-64 pl-1')}
                data-agent-chat-session-reference={title}
                role="img"
            >
                <MessageCircle aria-hidden="true" className="size-3 shrink-0 text-muted" />
                <span className="min-w-0 truncate">@{title}</span>
            </span>
        </Tooltip>
    );
}

/**
 * A saved long paste in a sent message, drawn as the chip the composer showed while it was written: a document glyph
 * and `Pasted text · N lines`, never the multi-line note the Agent received. When the Chat can open files the chip
 * opens the original; it is an anchor so it wraps with the text around it, like the path pill.
 */
export function AgentChatLongPastePill({
    characterCount,
    lineCount,
    onOpen,
    path,
}: {
    characterCount: number;
    lineCount: number;
    onOpen: ((path: string) => void) | undefined;
    path: string;
}) {
    useTranslation();
    const { aria, detail, label } = agentChatLongPasteChipText(
        { characterCount, lineCount },
        onOpen !== undefined,
    );
    const content = (
        <>
            <FileText aria-hidden="true" className="size-3 shrink-0 text-muted" />
            {label}
        </>
    );
    return (
        <Tooltip content={detail}>
            {onOpen ? (
                <a
                    aria-label={aria}
                    className={`${PILL_CLASS_NAME} cursor-pointer pl-1 text-foreground no-underline hover:bg-border/75 focus-visible:outline focus-visible:outline-accent`}
                    data-agent-chat-long-paste={path}
                    href={path}
                    onClick={(event) => {
                        // Main denies every window navigation; `href` only makes the chip focusable and Enter-activated.
                        event.preventDefault();
                        onOpen(path);
                    }}
                >
                    {content}
                </a>
            ) : (
                <span
                    aria-label={aria}
                    className={cn(PILL_CLASS_NAME, 'pl-1')}
                    data-agent-chat-long-paste={path}
                    role="img"
                >
                    {content}
                </span>
            )}
        </Tooltip>
    );
}
