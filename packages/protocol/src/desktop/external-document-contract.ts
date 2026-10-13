import { z } from 'zod';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import { identifierSchema, pathSchema } from '../domain/identifiers.js';
import { fileAssetSchema } from '../domain/preview-asset.js';
import { terminalRecordSchema } from '../domain/terminal-record.js';
import { commandPolicy } from '../transport/method-spec.js';
import { externalEditorDocumentSchema } from './path-browser-contract.js';

const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');
const desktopControl = commandPolicy('desktop', 'control');
const serverControl = commandPolicy('server', 'control');

const documentTarget = z.object({ documentId: identifierSchema });
/**
 * A file a document refers to, written as a path relative to the document's folder (what a Markdown link or image
 * carries). Main resolves it and refuses anything outside that folder.
 */
const linkedTarget = documentTarget.extend({ path: z.string().min(1).max(4096) });
const documentSnapshot = z.object({
    content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
    mtimeMs: z.number().nonnegative(),
    size: z.number().int().nonnegative(),
});

/**
 * Methods acting on an external document: a file outside every added Project that Main already authorized and read.
 *
 * The Renderer names the document only by the opaque `documentId` Main issued when it read the file; the real path
 * never crosses IPC in this direction. Main resolves the ID against the documents it read in this process lifetime, so
 * a compromised Renderer cannot use these methods to reach an arbitrary path.
 */
export const externalDocumentDesktopMethods = {
    /**
     * Writes the editor buffer back to the file the document was read from. The path is reauthorized on every write and
     * never followed through a symbolic link.
     */
    'externalDocument.write': {
        ...desktopWrite,
        params: documentTarget.extend({
            content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
        }),
        result: documentSnapshot,
    },
    /**
     * Reads the document again, after `externalDocument.changed` reported that another app changed it.
     */
    'externalDocument.read': {
        ...desktopRead,
        params: documentTarget,
        result: documentSnapshot,
    },
    /**
     * Replaces the set of documents Main watches for changes made by other apps with the ones the Workbench has open.
     * An empty list stops watching.
     */
    'externalDocument.watch': {
        ...desktopControl,
        params: z.object({ documentIds: z.array(identifierSchema).max(512) }),
        result: z.null(),
    },
    /**
     * Reads an image the document's Markdown preview refers to, from the document's folder or below it.
     */
    'externalDocument.readAsset': {
        ...desktopRead,
        params: linkedTarget,
        result: fileAssetSchema,
    },
    /**
     * Opens a file a document's link points to, from the document's folder or below it, as another external document.
     */
    'externalDocument.openLinked': {
        ...desktopRead,
        params: linkedTarget,
        result: externalEditorDocumentSchema,
    },
    'externalDocument.reveal': {
        ...desktopControl,
        params: documentTarget,
        result: z.null(),
    },
    'externalDocument.openWithDefaultApp': {
        ...desktopControl,
        params: documentTarget,
        result: z.null(),
    },
    /**
     * Opens a shell Terminal in the Session, starting in the document's folder.
     */
    'externalDocument.openInTerminal': {
        ...desktopControl,
        params: documentTarget.extend({ sessionId: identifierSchema }),
        result: terminalRecordSchema,
    },
} as const;

/**
 * Server half of `externalDocument.openInTerminal`. Only Main may call it (see `desktopServerOperationIds`): the
 * ordinary `terminal.create` keeps a Renderer-supplied cwd inside the Session's roots, and this operation is how Main
 * vouches for one folder it authorized on the user's explicit request.
 */
export const externalDocumentServerMethods = {
    'terminal.createInExternalDirectory': {
        ...serverControl,
        params: z.object({ sessionId: identifierSchema, cwd: pathSchema }),
        result: terminalRecordSchema,
    },
} as const;
