import type { MobileUpdatePrepareResult } from '@caxri/protocol';
import { File, Paths } from 'expo-file-system';
import { startActivityAsync } from 'expo-intent-launcher';

import type { MobileUpdateInstallPorts } from './mobile-update-state';

/**
 * `Intent.FLAG_GRANT_READ_URI_PERMISSION`, so the package installer can read the private cache file.
 */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * The deprecated `md5` getter read as null for an unreadable file. Keep that, so the caller reports an incomplete
 * download instead of a raw digest error.
 */
const readMd5 = async (file: File): Promise<string | null> => {
    try {
        return await file.digest('MD5');
    } catch {
        return null;
    }
};

export const downloadMobileUpdate: MobileUpdateInstallPorts['download'] = async (
    prepared: MobileUpdatePrepareResult,
    onProgress,
) => {
    const destination = new File(Paths.cache, `caxri-mobile-${prepared.bundle.versionCode}.apk`);
    const file = await File.downloadFileAsync(prepared.url, destination, {
        idempotent: true,
        onProgress: ({ bytesWritten }) => onProgress(bytesWritten / prepared.bundle.sizeBytes),
    });
    return {
        contentUri: file.contentUri,
        discard: () => file.delete(),
        md5: await readMd5(file),
        sizeBytes: file.size,
    };
};

export const launchMobileUpdateInstaller: MobileUpdateInstallPorts['launchInstaller'] = async (
    contentUri,
) => {
    await startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        flags: FLAG_GRANT_READ_URI_PERMISSION,
        type: 'application/vnd.android.package-archive',
    });
};
