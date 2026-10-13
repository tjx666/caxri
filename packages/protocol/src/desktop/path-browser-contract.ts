import { z } from 'zod';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import { fileEntrySchema } from '../domain/domain.js';
import { identifierSchema, pathSchema } from '../domain/identifiers.js';
import { commandPolicy } from '../transport/method-spec.js';

export const MAX_PATH_BROWSER_ENTRIES = 200;

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
    /**
     * Display-only Project-relative directory of a `projectSearch` result, without a trailing slash and empty at the
     * root. Directory listings omit it because every row already shares the snapshot's `directoryLabel`.
     */
    directoryLabel: z.string().max(4_096).optional(),
    /**
     * Display-only symlink metadata, reused from the Server file entry so the dialog row carries the same folder/file
     * icon, tooltip, and screen-reader rationale as the Files tree. Main forwards what Server Core probed; it never
     * resolves or authorizes the target.
     */
    linkKind: fileEntrySchema.shape.linkKind,
    linkTarget: fileEntrySchema.shape.linkTarget,
    name: pathBrowserEntryName,
    size: z.number().int().nonnegative().optional(),
    /**
     * Which lookup produced this row. Both kinds arrive in one list, so the source has to travel per row: a
     * `projectSearch` row names a file anywhere under the Project root and is never a completion of the typed path,
     * while a `directory` row is a child of the listed directory.
     */
    source: z.enum(['directory', 'projectSearch']),
});
const pathBrowserSnapshot = z.object({
    browserId: identifierSchema,
    canCreate: z.boolean(),
    canGoParent: z.boolean(),
    directoryLabel: z.string().max(4_096),
    entries: z.array(pathBrowserEntry).max(MAX_PATH_BROWSER_ENTRIES),
    input: z.string().max(4_096),
    mode: z.enum(['project', 'free']),
    /**
     * Outcome of the Project-wide name search that runs beside the directory listing for a bare Project-mode filter. It
     * is reported separately from `truncated`, which describes the directory listing only, because the two lookups fail
     * independently and the dialog shows both groups at once: a search that could not run has to say so in its own
     * group rather than disappear into an apparently complete list.
     *
     * `skipped` means no search was asked for: free mode, an empty filter, or an input carrying a path separator.
     */
    projectSearch: z.enum(['skipped', 'complete', 'incomplete', 'unavailable']),
    rootLabel: z.string().min(1).max(1_024).optional(),
    truncated: z.boolean(),
});
const nonnegativeInteger = z.number().int().nonnegative();
/**
 * One bounded snapshot of a file outside every Project that Main already authorized and read; the Renderer opens it as
 * an ephemeral tab and writes it back through `externalDocument.write` with the same `id`.
 */
export const externalEditorDocumentSchema = z.object({
    id: identifierSchema,
    name: pathBrowserEntryName,
    displayPath: pathSchema,
    content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
    mtimeMs: z.number().nonnegative(),
    size: nonnegativeInteger.max(MAX_CONFIGURABLE_FILE_BYTES),
});
const pathBrowserOpened = z.discriminatedUnion('kind', [
    z.object({ opened: z.literal(true), kind: z.literal('project') }),
    z.object({
        opened: z.literal(true),
        kind: z.literal('external'),
        document: externalEditorDocumentSchema,
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
 * Server-owned support for the path browser's subpath fallback: a bounded Project-wide directory-suffix lookup. Server
 * Core returns the shallowest matching directory inside the Session's Project root (or `null` when nothing matched)
 * plus whether the traversal was truncated; Main still revalidates that directory before listing it.
 */
export const pathBrowserServerMethods = {
    'files.locateDirectory': {
        ...commandPolicy('server', 'read'),
        params: z.object({
            sessionId: identifierSchema,
            suffix: z.string().min(1).max(4096),
        }),
        result: z.object({ path: pathSchema.nullable(), truncated: z.boolean() }),
    },
};

/**
 * Everything the registry needs from this module in one spread, keeping the registry's import on one line.
 */
export const pathBrowserContractMethods = { ...pathBrowserMethods, ...pathBrowserServerMethods };
