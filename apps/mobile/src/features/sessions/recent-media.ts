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
     * A video's length in seconds.
     */
    durationSeconds?: number;
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
 * A video's length as the system gallery labels it: `0:07`, `12:30`, or `1:02:03` past an hour.
 */
export const formatMediaDuration = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
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
