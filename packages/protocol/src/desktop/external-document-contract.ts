import { z } from 'zod';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import { identifierSchema, pathSchema, terminalRecordSchema } from '../domain/domain.js';
import { commandPolicy } from '../transport/method-spec.js';

const desktopWrite = commandPolicy('desktop', 'write');
const desktopControl = commandPolicy('desktop', 'control');
const serverControl = commandPolicy('server', 'control');

const documentTarget = z.object({ documentId: identifierSchema });

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
        result: z.object({
            content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
            mtimeMs: z.number().nonnegative(),
            size: z.number().int().nonnegative(),
        }),
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
