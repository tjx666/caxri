import { z } from 'zod';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import { identifierSchema, pathSchema } from '../domain/domain.js';
import { commandPolicy } from '../transport/method-spec.js';

export const MAX_PATH_BROWSER_ENTRIES = 200;
/**
 * Mirrors the Project search result ceiling; the path browser only ever uses the shallowest match.
 */
export const MAX_FILE_LOCATE_DIRECTORY_MATCHES = 500;

const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');
const desktopControl = commandPolicy('desktop', 'control');
const entryTarget = z.object({ kind: z.literal('entry'), entryId: identifierSchema });
const parentTarget = z.object({ kind: z.literal('parent') });
const detachProjectTarget = z.object({ kind: z.literal('detachProject') });
const navigationTarget = z.discriminatedUnion('kind', [
    entryTarget,
    parentTarget,
    detachProjectTarget,
]);
const pathBrowserEntryName = z.string().min(1).max(255);
const pathBrowserEntry = z.object({
    id: identifierSchema,
    kind: z.enum(['directory', 'file', 'symlink']),
    name: pathBrowserEntryName,
    size: z.number().int().nonnegative().optional(),
});
const pathBrowserSnapshot = z.object({
    browserId: identifierSchema,
    canCreate: z.boolean(),
    canGoParent: z.boolean(),
    directoryLabel: z.string().max(4_096),
    entries: z.array(pathBrowserEntry).max(MAX_PATH_BROWSER_ENTRIES),
    input: z.string().max(4_096),
    mode: z.enum(['project', 'free']),
    rootLabel: z.string().min(1).max(1_024).optional(),
    truncated: z.boolean(),
});
const nonnegativeInteger = z.number().int().nonnegative();
const externalDocument = z.object({
    id: identifierSchema,
    name: pathBrowserEntryName,
    displayPath: pathSchema,
    content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
    mtimeMs: z.number().nonnegative(),
    size: nonnegativeInteger.max(MAX_CONFIGURABLE_FILE_BYTES),
    readOnly: z.literal(true),
});
const pathBrowserOpened = z.discriminatedUnion('kind', [
    z.object({ opened: z.literal(true), kind: z.literal('project') }),
    z.object({
        opened: z.literal(true),
        kind: z.literal('external'),
        document: externalDocument,
    }),
]);
const pathBrowserNavigationResult = z.union([pathBrowserOpened, pathBrowserSnapshot]);

/**
 * Main owns path-browser locations and entry IDs so the Renderer cannot expand an opaque folder grant into raw
 * filesystem access. Only the user's typed path crosses this boundary.
 */
export const pathBrowserMethods = {
    'pathBrowser.start': {
        ...desktopControl,
        params: z.object({ sessionId: identifierSchema }),
        result: pathBrowserSnapshot,
    },
    'pathBrowser.browse': {
        ...desktopRead,
        params: z.object({
            browserId: identifierSchema,
            mode: z.enum(['project', 'free']),
            input: z.string().max(4_096),
        }),
        result: pathBrowserSnapshot,
    },
    'pathBrowser.navigate': {
        ...desktopControl,
        params: z.object({ browserId: identifierSchema, target: navigationTarget }),
        result: pathBrowserNavigationResult,
    },
    'pathBrowser.open': {
        ...desktopWrite,
        params: z.object({ browserId: identifierSchema, entryId: identifierSchema }),
        result: pathBrowserOpened,
    },
    'pathBrowser.close': {
        ...desktopControl,
        params: z.object({ browserId: identifierSchema }),
        result: z.null(),
    },
} as const;

/**
 * Server-owned support for the path browser's subpath fallback: a bounded Project-wide directory-suffix lookup. Matches
 * are absolute paths inside the Session's Project root, sorted by relative path; Main still revalidates the chosen
 * directory before listing it.
 */
export const pathBrowserServerMethods = {
    'files.locateDirectory': {
        ...commandPolicy('server', 'read'),
        params: z.object({
            sessionId: identifierSchema,
            suffix: z.string().min(1).max(4096),
        }),
        result: z.object({
            paths: z.array(pathSchema).max(MAX_FILE_LOCATE_DIRECTORY_MATCHES),
            truncated: z.boolean(),
        }),
    },
};

/**
 * Everything the registry needs from this module in one spread, keeping the registry's import on one line.
 */
export const pathBrowserContractMethods = { ...pathBrowserMethods, ...pathBrowserServerMethods };
