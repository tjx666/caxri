/**
 * One recent photo or video from the phone's library, as the composer's add sheet shows it above the attachment
 * sources. `uri` is a local file the image strip, the upload, and the video cover can all read.
 */
export interface RecentMedia {
    /**
     * The library's identifier for the asset; stable across sheet openings, so it keys the thumbnail.
     */
    id: string;
    kind: 'image' | 'video';
    uri: string;
    width: number;
    height: number;
    filename?: string;
    /**
     * A video's length in milliseconds, as `expo-media-library` reports it on both platforms.
     */
    durationMs?: number;
}

/**
 * How many of the newest photos and videos the add sheet offers. The row scrolls sideways; anything older is one tap
 * away through the full library picker.
 */
export const RECENT_MEDIA_LIMIT = 16;

/**
 * What the add sheet does about library access when it opens: read the library, ask once, or stay quiet. A user who
 * already declined is never asked again from here; the sheet simply keeps its tiles, as before the row existed.
 */
export const recentMediaAccessStep = (permission: {
    granted: boolean;
    status: string;
}): 'ask' | 'read' | 'skip' => {
    if (permission.granted) return 'read';
    return permission.status === 'undetermined' ? 'ask' : 'skip';
};

/**
 * A video's length, given in milliseconds, as the system gallery labels it: `0:07`, `12:30`, or `1:02:03` past an hour.
 */
export const formatMediaDuration = (milliseconds: number): string => {
    const total = Math.max(0, Math.round(milliseconds / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = String(total % 60).padStart(2, '0');
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
        : `${minutes}:${rest}`;
};

/**
 * Whether a picked photo or video joins the composer as a file rather than an image: every video, and every photo when
 * the composer cannot take images. `undefined` means the composer has no file route, so a video cannot attach at all.
 */
export const attachesAsFile = (
    kind: 'image' | 'video',
    files: { imagesAsFiles: boolean } | undefined,
): boolean | undefined => {
    if (files === undefined) return kind === 'video' ? undefined : false;
    return files.imagesAsFiles || kind === 'video';
};

/**
 * Media types by extension for the photos and videos a phone camera or download leaves in the library.
 */
const MEDIA_TYPES: Record<string, string> = {
    '3gp': 'video/3gpp',
    'avi': 'video/x-msvideo',
    'gif': 'image/gif',
    'heic': 'image/heic',
    'heif': 'image/heif',
    'jpeg': 'image/jpeg',
    'jpg': 'image/jpeg',
    'm4v': 'video/x-m4v',
    'mkv': 'video/x-matroska',
    'mov': 'video/quicktime',
    'mp4': 'video/mp4',
    'png': 'image/png',
    'webm': 'video/webm',
    'webp': 'image/webp',
};

/**
 * The media type a recent photo or video attaches with as a file. `expo-media-library` reports none, while the
 * composer's file card decides from it whether a file plays, as the library picker's assets carry one. An unknown
 * extension falls back to the generic `video/*` or `image/*`, which still names the right kind.
 */
export const recentMediaMimeType = (
    media: Pick<RecentMedia, 'filename' | 'kind' | 'uri'>,
): string => {
    const name = media.filename ?? media.uri;
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    return MEDIA_TYPES[extension] ?? `${media.kind}/*`;
};
