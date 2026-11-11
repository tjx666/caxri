import { useEffect, useState } from 'react';

import type { GranularPermission } from 'expo-media-library';
import {
    Asset,
    AssetField,
    getPermissionsAsync,
    MediaType,
    Query,
    requestPermissionsAsync,
} from 'expo-media-library';

import type { RecentMedia } from '../recent-media';
import { RECENT_MEDIA_LIMIT, recentMediaAccessStep } from '../recent-media';

/**
 * Read access only; the composer never writes to the library.
 */
const GRANULAR_PERMISSIONS: GranularPermission[] = ['photo', 'video'];

/**
 * The last row read, so reopening the sheet shows it at once while the library is read again.
 */
const lastRead: { items: readonly RecentMedia[] } = { items: [] };

const resolveRecentMedia = async (item: {
    id: string;
    mediaType: MediaType;
    filename: string | null;
    width: number | null;
    height: number | null;
    duration: number | null;
}): Promise<RecentMedia> => {
    const asset = new Asset(item.id);
    // `getUri` resolves a local `file://` path that `Image`, `expo-image-manipulator`, and `expo-video` all read,
    // where the identifier itself is a `content://` or `ph://` reference.
    const [uri, shape] = await Promise.all([
        asset.getUri(),
        item.width && item.height ? null : asset.getShape(),
    ]);
    return {
        id: item.id,
        kind: item.mediaType === MediaType.VIDEO ? 'video' : 'image',
        uri,
        width: item.width ?? shape?.width ?? 0,
        height: item.height ?? shape?.height ?? 0,
        ...(item.filename && { filename: item.filename }),
        ...(item.duration !== null && { durationSeconds: item.duration }),
    };
};

/**
 * The newest photos and videos, asking for library access the first time only. Declined access, or a library that
 * cannot be read, yields an empty row rather than an error: the sheet's tiles still reach the full picker.
 */
const readRecentMedia = async (): Promise<readonly RecentMedia[]> => {
    const step = recentMediaAccessStep(await getPermissionsAsync(false, GRANULAR_PERMISSIONS));
    if (step === 'skip') return [];
    if (step === 'ask' && !(await requestPermissionsAsync(false, GRANULAR_PERMISSIONS)).granted)
        return [];
    const items = await new Query()
        .within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO])
        .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
        .limit(RECENT_MEDIA_LIMIT)
        .exeForMetadata();
    const resolved = await Promise.allSettled(items.map(resolveRecentMedia));
    // An asset deleted or still in iCloud since the query is left out instead of emptying the row.
    return resolved.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
};

/**
 * The add sheet's recent photos and videos, read each time the sheet opens while `enabled`.
 */
export const useRecentMedia = (isEnabled: boolean): readonly RecentMedia[] => {
    const [media, setMedia] = useState(lastRead.items);
    useEffect(() => {
        if (!isEnabled) return;
        let isCurrent = true;
        void readRecentMedia()
            .catch((): readonly RecentMedia[] => [])
            .then((items) => {
                lastRead.items = items;
                if (isCurrent) setMedia(items);
            });
        return () => {
            isCurrent = false;
        };
    }, [isEnabled]);
    return isEnabled ? media : [];
};
