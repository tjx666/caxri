import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import type { AppLocale, ExtensionL10nBundle, ExtensionManifest } from '@caxri/protocol';
import {
    APP_LOCALES,
    extensionL10nBundleSchema,
    extensionL10nFileLocale,
    extensionManifestSchema,
    MAX_EXTENSION_L10N_FILE_BYTES,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, readBoundedRegularFileText } from '@caxri/system';

/**
 * The non-source languages an extension may translate into; English is the manifest's own (`package.nls.json`) text.
 */
const TRANSLATED_LOCALES = APP_LOCALES.filter((locale) => locale !== 'en');

/**
 * A manifest placeholder, VS Code style: the whole field is `%key%`.
 */
const PLACEHOLDER = /^%([^%]+)%$/;

/**
 * One extension's localized manifests and runtime bundles, read once at discovery so a language switch only selects
 * among results already validated.
 */
export interface ExtensionLocalization {
    /**
     * The manifest with every placeholder resolved in each language that resolved to a valid manifest. `en` is always
     * present; a language whose translation is missing or invalid is absent and falls back to `en`.
     */
    manifests: Partial<Record<AppLocale, ExtensionManifest>> & { en: ExtensionManifest };
    /**
     * Runtime `l10n.t` bundles, keyed by English source message, for each language the extension ships one for.
     */
    runtimeBundles: Partial<Record<AppLocale, ExtensionL10nBundle>>;
    /**
     * Localization files that exist but could not be used, for one discovery warning per file. Their language falls
     * back to English instead of rejecting the extension.
     */
    ignoredFiles: Array<{ file: string; reason: LocalizationFileIssue }>;
}

export type LocalizationFileIssue = 'escapes-root' | 'invalid' | 'manifest-invalid' | 'unreadable';

type FileRead =
    | { kind: 'absent' }
    | { kind: 'bundle'; bundle: ExtensionL10nBundle }
    | { kind: 'ignored'; reason: LocalizationFileIssue };

function isInside(rootPath: string, candidate: string): boolean {
    const nested = relative(rootPath, candidate);
    return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested));
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    );
}

/**
 * Reads one localization file the way discovery reads `package.json`: bounded, regular files only, and never through a
 * link that leaves the extension root, because an installed extension's root is user-writable.
 */
async function readBundle(rootPath: string, file: string): Promise<FileRead> {
    let path: string;
    try {
        path = await realpath(join(rootPath, file));
    } catch (error) {
        return isMissing(error) ? { kind: 'absent' } : { kind: 'ignored', reason: 'unreadable' };
    }
    if (!isInside(rootPath, path)) return { kind: 'ignored', reason: 'escapes-root' };
    let source: string;
    try {
        source = await readBoundedRegularFileText(path, MAX_EXTENSION_L10N_FILE_BYTES);
    } catch {
        return { kind: 'ignored', reason: 'unreadable' };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(source) as unknown;
    } catch {
        return { kind: 'ignored', reason: 'invalid' };
    }
    const parsed = extensionL10nBundleSchema.safeParse(raw);
    return parsed.success
        ? { kind: 'bundle', bundle: parsed.data }
        : { kind: 'ignored', reason: 'invalid' };
}

function resolveText(value: string, bundles: readonly ExtensionL10nBundle[]): string {
    const key = PLACEHOLDER.exec(value)?.[1];
    if (key === undefined) return value;
    for (const bundle of bundles) if (Object.hasOwn(bundle, key)) return bundle[key];
    return value;
}

/**
 * Resolves placeholders in the fields a person reads: container titles, view names and status copy, and command titles
 * and descriptions. Ids, commands, and every other field stay literal, so a translation can never re-point a
 * contribution. `bundles` is searched in order, the requested language before the default.
 */
export function localizeManifest(
    manifest: ExtensionManifest,
    bundles: readonly ExtensionL10nBundle[],
): ExtensionManifest {
    const text = (value: string) => resolveText(value, bundles);
    const { contributes } = manifest;
    return {
        ...manifest,
        contributes: {
            ...contributes,
            viewsContainers: {
                secondarySidebar: contributes.viewsContainers.secondarySidebar.map((container) => ({
                    ...container,
                    title: text(container.title),
                })),
                panel: contributes.viewsContainers.panel.map((container) => ({
                    ...container,
                    title: text(container.title),
                })),
            },
            views: Object.fromEntries(
                Object.entries(contributes.views).map(([containerId, views]) => [
                    containerId,
                    views.map((view) => ({
                        ...view,
                        name: text(view.name),
                        ...(view.presentation && {
                            presentation: {
                                noContextMessage: text(view.presentation.noContextMessage),
                                loadingMessage: text(view.presentation.loadingMessage),
                                actionErrorMessage: text(view.presentation.actionErrorMessage),
                                refreshErrorMessage: text(view.presentation.refreshErrorMessage),
                            },
                        }),
                    })),
                ]),
            ),
            commands: contributes.commands.map((command) => ({
                ...command,
                title: text(command.title),
                ...(command.description !== undefined && {
                    description: text(command.description),
                }),
            })),
        },
    };
}

/**
 * Validates a localized manifest against the same schema as the source, since a translation can exceed a length bound
 * or resolve to an empty string that the `%key%` placeholder itself satisfied.
 */
function validLocalizedManifest(manifest: ExtensionManifest): ExtensionManifest | undefined {
    const parsed = extensionManifestSchema.safeParse(manifest);
    return parsed.success ? parsed.data : undefined;
}

/**
 * One discovery warning per localization file an extension ships but Caxri could not use.
 */
export function logIgnoredLocalization(
    logger: StructuredLogger,
    extension: { extensionId: string; localization: ExtensionLocalization },
): void {
    for (const { file, reason } of extension.localization.ignoredFiles)
        logger.write('warn', logEventCatalog.extensionHost.localizationIgnored, {
            fields: { extensionId: extension.extensionId, file, reason },
        });
}

export class ManifestLocalizationError extends Error {
    constructor() {
        super('Extension package.nls.json does not resolve to a valid manifest');
    }
}

/**
 * Reads `package.nls.json`, `package.nls.<locale>.json`, and `l10n/bundle.l10n.<locale>.json` from a canonical
 * extension root. Every file is optional: an extension that ships none keeps its manifest text in every language.
 *
 * The default (`package.nls.json`) resolution is the extension's own text, so a default that does not yield a valid
 * manifest rejects the extension like any other manifest error; a translation that does not only drops that language.
 */
export async function readExtensionLocalization(
    rootPath: string,
    manifest: ExtensionManifest,
): Promise<ExtensionLocalization> {
    const ignoredFiles: ExtensionLocalization['ignoredFiles'] = [];
    const read = async (file: string): Promise<ExtensionL10nBundle | undefined> => {
        const result = await readBundle(rootPath, file);
        if (result.kind === 'ignored') ignoredFiles.push({ file, reason: result.reason });
        return result.kind === 'bundle' ? result.bundle : undefined;
    };
    const defaultBundle = await read('package.nls.json');
    const defaultBundles = defaultBundle ? [defaultBundle] : [];
    const en = validLocalizedManifest(localizeManifest(manifest, defaultBundles));
    if (!en) throw new ManifestLocalizationError();
    const manifests: ExtensionLocalization['manifests'] = { en };
    const runtimeBundles: ExtensionLocalization['runtimeBundles'] = {};
    await Promise.all(
        TRANSLATED_LOCALES.map(async (locale) => {
            const suffix = extensionL10nFileLocale(locale);
            const [manifestBundle, runtimeBundle] = await Promise.all([
                read(`package.nls.${suffix}.json`),
                read(`l10n/bundle.l10n.${suffix}.json`),
            ]);
            if (runtimeBundle) runtimeBundles[locale] = runtimeBundle;
            if (!manifestBundle) return;
            const localized = validLocalizedManifest(
                localizeManifest(manifest, [manifestBundle, ...defaultBundles]),
            );
            if (localized) manifests[locale] = localized;
            else
                ignoredFiles.push({
                    file: `package.nls.${suffix}.json`,
                    reason: 'manifest-invalid',
                });
        }),
    );
    return { manifests, runtimeBundles, ignoredFiles };
}
