import { useState } from 'react';

import { agentChatMediaUrl } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { Film, Play } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { openAgentChatPathReference } from '../agent-chat-commands';
import { agentChatMessageVideoPaths } from './agent-chat-path-pills';

/**
 * The videos a sent message cites, as tiles under its text inside the bubble, the way its images sit there, so a
 * message with a screen recording reads as one message. Each tile shows the video's poster frame with a play button and
 * its name, as t3code's video attachment does; clicking it plays the video (`AgentChatVideoPlayerDialog`). With no
 * video in `text` it renders nothing.
 */
export function AgentChatMessageVideos({ className, text }: { className?: string; text: string }) {
    const [playing, setPlaying] = useState<string>();
    const paths = agentChatMessageVideoPaths(text);
    if (paths.length === 0) return null;
    return (
        <>
            <div className={cn('flex flex-wrap gap-1.5', className)}>
                {paths.map((path) => (
                    <VideoTile key={path} path={path} onPlay={() => setPlaying(path)} />
                ))}
            </div>
            <AgentChatVideoPlayerDialog path={playing} onClose={() => setPlaying(undefined)} />
        </>
    );
}

function VideoTile({ path, onPlay }: { path: string; onPlay: () => void }) {
    const { t } = useTranslation();
    const [hasPoster, setHasPoster] = useState(true);
    const name = pathBasename(path) || path;
    return (
        <Tooltip content={path}>
            <button
                aria-label={t('agentChat.message.playVideo', { name })}
                className="group relative flex h-28 w-48 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-border bg-background p-0 text-muted focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                data-agent-chat-video={path}
                type="button"
                onClick={onPlay}
            >
                {hasPoster ? (
                    <img
                        alt=""
                        className="absolute inset-0 size-full object-cover"
                        src={agentChatMediaUrl('poster', path)}
                        onError={() => setHasPoster(false)}
                    />
                ) : (
                    <Film aria-hidden="true" className="absolute top-3 size-5" />
                )}
                <span className="relative flex size-9 items-center justify-center rounded-full bg-background/75 text-foreground shadow-sm backdrop-blur-sm transition-transform group-hover:scale-110">
                    <Play aria-hidden="true" className="ml-0.5 size-4 fill-current" />
                </span>
                <span className="absolute inset-x-0 bottom-0 truncate bg-linear-to-t from-background/90 to-transparent px-2 pt-4 pb-1 text-left text-[11px] leading-4 text-foreground">
                    {name}
                </span>
            </button>
        </Tooltip>
    );
}

/**
 * Plays the video at `path` while it is set, with the native controls so the user can scrub and go full screen, as
 * Orca's media viewer does. Only the metadata loads until playback starts, and a video that cannot play (moved, or a
 * codec Chromium lacks) says so and offers Show in Finder instead of a blank player.
 */
export function AgentChatVideoPlayerDialog({
    path,
    onClose,
}: {
    path: string | undefined;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [failedPath, setFailedPath] = useState<string>();
    const name = path ? pathBasename(path) || path : '';
    return (
        <Dialog
            open={path !== undefined}
            onOpenChange={(isOpen) => {
                if (!isOpen) onClose();
            }}
        >
            <DialogContent className="w-auto max-w-[min(1200px,calc(100vw-32px))] p-3">
                <DialogHeader>
                    <DialogTitle className="mb-2 truncate pr-8 text-[13px] font-normal text-muted">
                        {name}
                    </DialogTitle>
                </DialogHeader>
                {path !== undefined &&
                    (failedPath === path ? (
                        <div className="flex w-120 max-w-full flex-col items-center gap-3 px-6 py-10 text-center text-[13px] text-muted">
                            <Film aria-hidden="true" className="size-6" />
                            <p className="m-0">{t('agentChat.message.videoUnplayable')}</p>
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => openAgentChatPathReference(path)}
                            >
                                {t('agentChat.message.revealVideo')}
                            </Button>
                        </div>
                    ) : (
                        <video
                            className="block max-h-[calc(100vh-140px)] max-w-full rounded-md bg-background"
                            controls
                            poster={agentChatMediaUrl('poster', path)}
                            preload="metadata"
                            ref={playOnMount}
                            src={agentChatMediaUrl('video', path)}
                            onError={() => setFailedPath(path)}
                        />
                    ))}
            </DialogContent>
        </Dialog>
    );
}

/**
 * Starts the player once it mounts. The user's click on a tile or pill opened it, so Chromium lets it play with sound;
 * `autoPlay` would mean the same here, but reads as media that starts by itself. A refused start leaves the native play
 * button.
 */
function playOnMount(video: HTMLVideoElement | null): void {
    if (video) void startPlayback(video);
}

async function startPlayback(video: HTMLVideoElement): Promise<void> {
    try {
        await video.play();
    } catch {
        // Chromium refused to start; the native controls still offer play.
    }
}
