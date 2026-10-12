import { z } from 'zod';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import { MAX_PATH_BROWSER_ENTRIES } from '../desktop/path-browser-contract.js';
import { CaxriError, isCaxriError } from '../transport/errors.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import {
    canceledResultSchema,
    fileDocumentSchema,
    fileEntrySchema,
    fileMutationOperationSchema,
    identifierSchema,
    movedFileEntrySchema,
    mutableFileEntrySchema,
    pathSchema,
} from './domain.js';
import { fileSearchModeSchema, fileSearchResultSchema } from './file-search.js';
import { fileAssetSchema } from './preview-asset.js';

/**
 * The stable `details.reason` a text read carries when the file holds binary content. Binary is only known after the
 * content is read (an extension cannot predict it), so callers branch on this reason instead of matching the message:
 * the Desktop opens a no-preview tab and Mobile answers `{ status: 'binary' }`.
 */
export const BINARY_FILE_READ_REASON = 'binary';

export function binaryFileReadError(): CaxriError {
    return new CaxriError('IO', 'Binary files cannot be opened in the editor', {
        reason: BINARY_FILE_READ_REASON,
    });
}

export function isBinaryFileReadError(error: unknown): boolean {
    return (
        isCaxriError(error) &&
        error.code === 'IO' &&
        error.details?.reason === BINARY_FILE_READ_REASON
    );
}

const serverRead = commandPolicy('server', 'read');
const serverWrite = commandPolicy('server', 'write');
const serverControl = commandPolicy('server', 'control');
const desktopWrite = commandPolicy('desktop', 'write');

export const MAX_FILE_BROWSE_ENTRIES = MAX_PATH_BROWSER_ENTRIES;
/**
 * Keeps one expanded Files tree directory within the controlled Renderer and transport budget. The result carries an
 * explicit truncation bit so a large directory never silently appears complete.
 */
export const MAX_FILE_LIST_ENTRIES = 1_024;
/**
 * Import links are resolved for the whole open document at once, so this caps how much filesystem probing one editor
 * model can ask for. A file with more imports than this keeps links for the first ones it declares.
 */
export const MAX_RESOLVED_IMPORTS = 128;
const resolvedImportSchema = z.object({ specifier: z.string(), path: pathSchema });
const importSpecifierSchema = z.string().min(1).max(1_024);

const authorizedFileEntry = mutableFileEntrySchema.extend({
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
    root: z.object({
        path: pathSchema,
        device: z.string().regex(/^\d+$/),
        inode: z.string().regex(/^\d+$/),
    }),
});
const fileName = z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
        (name) =>
            name !== '.' &&
            name !== '..' &&
            !name.includes('/') &&
            !name.includes('\\') &&
            !name.includes('\0'),
        'File name must not contain path separators',
    );

/**
 * Every public `files.*` command: directory listing, browse search, CRUD, move/copy/rename, the async mutation
 * operation ledger, content read/write, and full-text search. Server-owned throughout except `files.trash`, which
 * routes through Desktop because Trash is a native, irreversible-adjacent filesystem action.
 */
export const fileMethods = {
    'files.list': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema, directory: pathSchema.optional() }),
        result: z.object({
            entries: z.array(fileEntrySchema).max(MAX_FILE_LIST_ENTRIES),
            truncated: z.boolean(),
        }),
    },
    'files.resolveKind': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: z.enum(['file', 'directory']),
    },
    /**
     * Turns module specifiers written in one open document (`'./foo'`, `'@/errors'`) into the files they name, so the
     * editor can offer them as links. Batched per document because the editor asks on every model change and a request
     * per import would multiply that by the import count.
     *
     * Only specifiers that resolve to a regular file inside the Session's authorized Project are returned; an
     * unresolvable one is simply absent, which is what keeps an alias or a bare package name from rendering as a link
     * that would jump somewhere wrong.
     */
    'files.resolveImports': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            from: pathSchema,
            specifiers: z.array(importSpecifierSchema).max(MAX_RESOLVED_IMPORTS),
        }),
        result: z.object({
            resolved: z.array(resolvedImportSchema).max(MAX_RESOLVED_IMPORTS),
        }),
    },
    'files.browse': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            directory: pathSchema.optional(),
            query: z.string().max(255),
        }),
        result: z.object({
            entries: z.array(fileEntrySchema).max(MAX_FILE_BROWSE_ENTRIES),
            truncated: z.boolean(),
        }),
    },
    'files.create': {
        ...serverWrite,
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            directory: pathSchema,
            name: fileName,
            kind: z.enum(['file', 'directory']).default('file'),
        }),
        result: mutableFileEntrySchema,
    },
    'files.copy': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            directory: pathSchema,
        }),
        result: mutableFileEntrySchema,
    },
    'files.rename': {
        ...serverWrite,
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            path: pathSchema,
            name: fileName,
        }),
        result: movedFileEntrySchema,
    },
    'files.move': {
        ...serverWrite,
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            path: pathSchema,
            directory: pathSchema,
            conflict: z.enum(['reject', 'rename', 'replace']).default('reject'),
        }),
        result: movedFileEntrySchema,
    },
    'files.operation.get': {
        ...serverRead,
        params: z.object({ operationId: identifierSchema, sessionId: identifierSchema }),
        result: fileMutationOperationSchema.nullable(),
    },
    'files.operation.list': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema }),
        result: z.array(fileMutationOperationSchema).max(256),
    },
    'files.operation.cancel': {
        ...serverControl,
        params: z.object({ operationId: identifierSchema, sessionId: identifierSchema }),
        result: fileMutationOperationSchema,
    },
    'files.operation.acknowledge': {
        ...serverWrite,
        params: z.object({ operationId: identifierSchema, sessionId: identifierSchema }),
        result: z.null(),
    },
    'files.trash': {
        ...desktopWrite,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            /**
             * Set when an open Editor tab holds unsaved changes for this path. The Trash can only restore the last
             * bytes written to disk, so the confirmation must stop promising that the item is fully recoverable.
             */
            hasUnsavedChanges: z.boolean().optional(),
        }),
        result: z.union([canceledResultSchema, mutableFileEntrySchema]),
    },
    'files.read': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: fileDocumentSchema,
    },
    'files.readAsset': {
        ...serverRead,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: fileAssetSchema,
    },
    'files.write': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
        }),
        result: fileDocumentSchema,
    },
    'files.search': {
        ...serverRead,
        params: z.object({
            sessionId: identifierSchema,
            /**
             * Each surface replaces only its own previous search within the Session.
             */
            consumer: z.enum(['project-search', 'path-browser', 'mobile-composer']),
            mode: fileSearchModeSchema,
            query: z.string().min(1).max(256),
            caseSensitive: z.boolean().default(false),
            wholeWord: z.boolean().default(false),
            regex: z.boolean().default(false),
            include: z.string().max(512).default(''),
            exclude: z.string().max(512).default(''),
            /**
             * Whether the repository's own ignore files (`.gitignore`, `.ignore`) narrow the scan, as VS Code's
             * `search.useIgnoreFiles` does and with the same default. Caxri's fixed traversal exclusions (VCS metadata,
             * dependency and build output) apply either way; this only decides whether the Project gets to add to them.
             * Off is the wider search, not the unbounded one.
             */
            useIgnoreFiles: z.boolean().default(true),
        }),
        result: fileSearchResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Internal Server operations that authorize a filesystem entry for Main's Trash/open flows; never reachable from the
 * Renderer request allowlist.
 */
export const fileInternalMethods = {
    'files.authorizeTrash': {
        ...serverControl,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: authorizedFileEntry,
    },
    'files.authorizeOpen': {
        ...serverControl,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: authorizedFileEntry,
    },
    /**
     * Moves an entry Main already confirmed into the Server host's own Trash. An SSH Host window uses it in place of
     * Electron's `shell.trashItem`, which would act on this Mac; `device` and `inode` are the identity the user
     * approved, so a path replaced after the dialog is refused instead of trashed.
     */
    'files.trashOnHost': {
        ...serverControl,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            device: z.string().regex(/^\d+$/),
            inode: z.string().regex(/^\d+$/),
        }),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;
