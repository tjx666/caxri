import type { MobileUpdatePrepareResult } from '@caxri/protocol';
import { File, Paths } from 'expo-file-system';
import { startActivityAsync } from 'expo-intent-launcher';

import type { MobileUpdateInstallPorts } from './mobile-update-state';

/**
 * `Intent.FLAG_GRANT_READ_URI_PERMISSION`, so the package installer can read the private cache file.
 */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

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
        md5: file.md5,
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
