import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Android release APK bundled with Desktop. A phone offers an update only when this `versionCode` is newer than its
 * own; the MD5 detects a corrupted download, while tampering is rejected by Android's signing-certificate check on
 * upgrade.
 */
export const mobileUpdateBundleSchema = z.strictObject({
    version: z
        .string()
        .regex(/^\d{1,4}\.\d{1,3}\.\d{1,3}$/u)
        .max(16),
    versionCode: z.number().int().positive().max(2_100_000_000),
    sizeBytes: z
        .number()
        .int()
        .positive()
        .max(512 * 1_024 * 1_024),
    md5: z.string().regex(/^[0-9a-f]{32}$/u),
});

/**
 * File names inside the Desktop's update bundle directory (`Resources/mobile` when packaged). The Android packaging
 * script writes both; Server Core only reads them.
 */
export const MOBILE_UPDATE_MANIFEST_FILE = 'manifest.json';
export const MOBILE_UPDATE_APK_FILE = 'caxri-mobile.apk';

const mobileUpdateCheckResultSchema = z.strictObject({
    bundle: mobileUpdateBundleSchema.nullable(),
});

/**
 * The public source repository. Release downloads, release notes, and issue reports all live under it.
 */
export const CAXRI_REPOSITORY_URL = 'https://github.com/tjx666/caxri';

/**
 * The public GitHub Release page for `version`, or the latest Release when the version is unknown.
 */
export const caxriReleaseUrl = (version: string | undefined): string =>
    version
        ? `${CAXRI_REPOSITORY_URL}/releases/tag/v${version}`
        : `${CAXRI_REPOSITORY_URL}/releases/latest`;

/**
 * The public GitHub Release asset for `version`. Every release publishes the exact release-signed APK it embeds in the
 * Desktop build, so a phone that cannot reach the gateway's HTTP endpoint (a Relay connection) downloads the same bytes
 * there and still verifies them against the sealed MD5.
 */
export const mobileReleaseApkUrl = (version: string): string =>
    `${CAXRI_REPOSITORY_URL}/releases/download/v${version}/Caxri-Mobile-${version}-android-arm64.apk`;

/**
 * Over a direct connection, `url` is a short-lived plain-HTTP address on the gateway endpoint the phone is already
 * connected to; the unguessable token in its path is the only authority, so it is issued exclusively over the sealed
 * channel. Over the Relay, the gateway has no address the phone can reach, so `url` is {@link mobileReleaseApkUrl}.
 */
export const mobileUpdatePrepareResultSchema = z.strictObject({
    bundle: mobileUpdateBundleSchema,
    expiresAt: z.number().int().positive(),
    url: z.url({ protocol: /^https?$/u }).max(2_048),
});

const noParameters = z.strictObject({}).default({});

/**
 * Desktop-delivered Android updates; see `docs/mobile/update.md`. Both are granted to every paired role because they
 * expose only the bundle Desktop ships and a download token scoped to the requesting device.
 */
export const mobileUpdateMethods = {
    'mobile.update.check': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: noParameters,
        result: mobileUpdateCheckResultSchema,
    },
    'mobile.update.prepare': {
        ...commandPolicy('server', 'control', ['sessions.read']),
        params: noParameters,
        result: mobileUpdatePrepareResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type MobileUpdateBundle = z.infer<typeof mobileUpdateBundleSchema>;
export type MobileUpdatePrepareResult = z.infer<typeof mobileUpdatePrepareResultSchema>;
