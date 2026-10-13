import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { pathSchema } from './identifiers.js';

const serverRead = commandPolicy('server', 'read');

/**
 * Upper bound for one `project.browseFolders` listing; larger directories report `truncated`.
 */
export const PROJECT_BROWSE_FOLDERS_MAX_ENTRIES = 500;

const projectFolderEntrySchema = z.object({
    name: z.string().min(1).max(255),
    path: pathSchema,
    isGitRepository: z.boolean(),
    hasChildren: z.boolean(),
});

/**
 * Remote folder browsing for the Add Project flow, used where the Server's file system is not reachable through a
 * native folder picker.
 */
export const projectFolderBrowseMethods = {
    /**
     * Lists the subfolders of one absolute directory on the Server's machine (the home directory when `path` is
     * omitted). An SSH Host window chooses a Project folder through this instead of a native picker, because the folder
     * lives on the remote machine; see docs/adr/0014-ssh-remote-server.md.
     */
    'project.browseFolders': {
        ...serverRead,
        params: z.object({ path: pathSchema.optional() }),
        result: z.object({
            path: pathSchema,
            parent: pathSchema.nullable(),
            home: pathSchema,
            entries: z.array(projectFolderEntrySchema).max(PROJECT_BROWSE_FOLDERS_MAX_ENTRIES),
            truncated: z.boolean(),
        }),
    },
} as const satisfies Record<string, MethodSpec>;
