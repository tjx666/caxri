import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

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
        ...(item.duration !== null && { durationMs: item.duration }),
    };
};

/**
 * What one read of the library found: the newest photos and videos, or that access was declined.
 */
interface RecentMediaRead {
    isDenied: boolean;
    items: readonly RecentMedia[];
}

/**
 * The newest photos and videos, asking for library access the first time only. Declined access reports `isDenied` so
 * the sheet can point at Settings; a library that cannot be read yields an empty row rather than an error, as the
 * sheet's tiles still reach the full picker.
 */
const readRecentMedia = async (): Promise<RecentMediaRead> => {
    const step = recentMediaAccessStep(await getPermissionsAsync(false, GRANULAR_PERMISSIONS));
    if (step === 'denied') return { isDenied: true, items: [] };
    if (step === 'ask' && !(await requestPermissionsAsync(false, GRANULAR_PERMISSIONS)).granted)
        return { isDenied: true, items: [] };
    const items = await new Query()
        .within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO])
        .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
        .limit(RECENT_MEDIA_LIMIT)
        .exeForMetadata();
    const resolved = await Promise.allSettled(items.map(resolveRecentMedia));
    // An asset deleted or still in iCloud since the query is left out instead of emptying the row.
    return {
        isDenied: false,
        items: resolved.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
    };
};

/**
 * The add sheet's recent photos and videos, read each time the sheet opens while `isEnabled`, and again when the app
 * returns to the foreground, so access granted in Settings shows the row without reopening the sheet.
 */
export const useRecentMedia = (isEnabled: boolean): RecentMediaRead => {
    const [read, setRead] = useState<RecentMediaRead>({ isDenied: false, items: lastRead.items });
    useEffect(() => {
        if (!isEnabled) return;
        let isCurrent = true;
        // The system permission dialog itself bounces the app through inactive and active; a read still waiting on it
        // must not start a second one, which would ask again.
        let isLoading = false;
        const load = (): void => {
            if (isLoading) return;
            isLoading = true;
            void readRecentMedia()
                .catch((): RecentMediaRead => ({ isDenied: false, items: [] }))
                .then((next) => {
                    isLoading = false;
                    lastRead.items = next.items;
                    if (isCurrent) setRead(next);
                });
        };
        load();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') load();
        });
        return () => {
            isCurrent = false;
            subscription.remove();
        };
    }, [isEnabled]);
    return isEnabled ? read : { isDenied: false, items: [] };
};
