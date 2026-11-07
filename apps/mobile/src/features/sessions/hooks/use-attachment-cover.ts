import { useEffect, useState } from 'react';

import type { FileAttachment } from '../file-attachment-store';
import { fileAttachmentKind } from '../file-attachment-store';
import { videoCovers } from '../video-cover';

/**
 * What a pending file's card shows in place of its glyph: an image file itself, or a video's first frame once it is
 * grabbed from the phone's copy. `undefined` keeps the glyph: other kinds, a video still being read, or one whose frame
 * could not be read.
 */
export const useAttachmentCover = (
    file: Pick<FileAttachment, 'mimeType' | 'name' | 'uri'>,
): string | undefined => {
    const kind = fileAttachmentKind(file);
    const videoUri = kind === 'video' ? file.uri : undefined;
    const [loaded, setLoaded] = useState<{ uri: string; cover: string | null }>();
    useEffect(() => {
        if (videoUri === undefined || videoCovers.peek(videoUri) !== undefined) return;
        let isCurrent = true;
        void videoCovers.load(videoUri).then((cover) => {
            if (isCurrent) setLoaded({ uri: videoUri, cover });
        });
        return () => {
            isCurrent = false;
        };
    }, [videoUri]);
    if (kind === 'image') return file.uri;
    if (videoUri === undefined) return undefined;
    const cover = videoCovers.peek(videoUri) ?? (loaded?.uri === videoUri ? loaded.cover : null);
    return cover ?? undefined;
};
