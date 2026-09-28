import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { MobileUpdateBundle, MobileUpdatePrepareResult, ServerRequest } from '@caxri/protocol';
import {
    CaxriError,
    MOBILE_UPDATE_APK_FILE,
    MOBILE_UPDATE_MANIFEST_FILE,
    mobileUpdateBundleSchema,
} from '@caxri/protocol';

export interface MobileUpdateSource {
    apkPath: string;
    bundle: MobileUpdateBundle;
}

const isMissingFile = (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * Reads the Android APK that ships beside this Desktop build. A directory without a manifest is a supported state
 * (development builds and packages built without Android tooling); a manifest that disagrees with its APK is not.
 */
export const readMobileUpdateSource = async (
    directory: string | undefined,
): Promise<MobileUpdateSource | undefined> => {
    if (!directory) return undefined;
    let source: string;
    try {
        source = await readFile(join(directory, MOBILE_UPDATE_MANIFEST_FILE), 'utf8');
    } catch (error) {
        if (isMissingFile(error)) return undefined;
        throw error;
    }
    const bundle = mobileUpdateBundleSchema.parse(JSON.parse(source) as unknown);
    const apkPath = join(directory, MOBILE_UPDATE_APK_FILE);
    const apk = await stat(apkPath);
    if (!apk.isFile() || apk.size !== bundle.sizeBytes)
        throw new CaxriError('IO', 'The bundled mobile update does not match its manifest');
    return { apkPath, bundle };
};

/**
 * Lets a development instance serve a locally built bundle; packaged builds read the copy under `Resources/mobile`.
 */
const MOBILE_UPDATE_DIRECTORY_ENVIRONMENT_KEY = 'CAXRI_MOBILE_UPDATE_DIRECTORY';

/**
 * Resolved from the Server bundle's own location (`Resources/server/bundles` in a package), not from
 * `process.resourcesPath`: Server Core runs on the bundled plain Node runtime, where that Electron-only property is
 * undefined, so a package never found its APK and every phone was told no update existed. A development build has no
 * sibling `mobile` directory, which reads as "no bundle".
 */
export const mobileUpdateDirectoryForServer = (options: {
    environment: Readonly<Record<string, string | undefined>>;
    serverBundleDirectory: string;
}): string => {
    const override = options.environment[MOBILE_UPDATE_DIRECTORY_ENVIRONMENT_KEY];
    if (override) return override;
    return resolve(options.serverBundleDirectory, '../../mobile');
};

type MobileUpdateRequest = Extract<
    ServerRequest,
    { method: 'mobile.update.check' | 'mobile.update.prepare' }
>;

/**
 * Answers the update methods for an already authorized paired device, and exposes the same cached bundle to update
 * recovery. The bundle is immutable for this Server lifetime, so the first successful read serves every later request;
 * a failed read is retried next time.
 */
export const createMobileUpdateRequests = (directory: string | undefined) => {
    let source: Promise<MobileUpdateSource | undefined> | undefined;
    const readSource = async (): Promise<MobileUpdateSource | undefined> => {
        source ??= readMobileUpdateSource(directory);
        try {
            return await source;
        } catch (error) {
            source = undefined;
            throw error;
        }
    };
    return {
        readSource,
        invoke: async (
            request: MobileUpdateRequest,
            prepareDownload: (
                source: MobileUpdateSource,
            ) => Omit<MobileUpdatePrepareResult, 'bundle'>,
        ) => {
            const current = await readSource();
            if (request.method === 'mobile.update.check')
                return { bundle: current?.bundle ?? null };
            if (!current)
                throw new CaxriError('NOT_FOUND', 'This Desktop build has no mobile update');
            return { bundle: current.bundle, ...prepareDownload(current) };
        },
    };
};
