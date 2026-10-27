import { z } from 'zod';

import { desktopOpenIdentitySchema } from '../desktop/desktop-contract.js';
import { externalEditorDocumentSchema } from '../desktop/path-browser-contract.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { canceledResultSchema } from './domain.js';
import { editorNavigationTargetSchema } from './editor.js';
import { identifierSchema, pathSchema } from './identifiers.js';

const serverControl = commandPolicy('server', 'control');
const desktopControl = commandPolicy('desktop', 'control');

/**
 * Safe display metadata for one authorized Terminal file-link candidate. The absolute path remains subject to Server
 * revalidation when selected; the Renderer uses only the relative path and Project title for disambiguation.
 */
export const terminalFileLinkCandidateSchema = z.object({
    path: pathSchema,
    relativePath: z.string().min(1).max(16_384),
    projectId: identifierSchema,
    projectTitle: z.string().min(1).max(512),
});

export const terminalFileLinkAmbiguousResultSchema = z.object({
    status: z.literal('ambiguous'),
    candidates: z.array(terminalFileLinkCandidateSchema).min(1).max(50),
    truncated: z.boolean(),
});

export const terminalFileLinkAmbiguousResolutionSchema =
    terminalFileLinkAmbiguousResultSchema.extend({ sourceSessionId: identifierSchema });

export type TerminalFileLinkCandidate = z.infer<typeof terminalFileLinkCandidateSchema>;

/**
 * Why the open did not happen. The reason is absent exactly when the user is the one who stopped it: dismissing the
 * Session chooser or declining to trust an external folder needs no explanation handed back to them. It is present when
 * Main refused on its own, which without it reads to the user as the link doing nothing at all.
 */
export const terminalFileLinkRefusalReasonSchema = z.enum([
    /**
     * The link resolved into a Project that exists only as some Session's linked worktree. Server Core will not create
     * a Session inside one, and by the time Main looked, none was using it as a Workbench Root any more. Named for that
     * missing binding rather than for ownership: in this codebase an "owned" Project _is_ the worktree Project.
     */
    'worktree_project_unbound',
    /**
     * The Project row resolved by Server Core was gone by the time Main read the bootstrap state.
     */
    'project_gone',
    /**
     * An SSH Host window resolved the link outside every Project. Opening it would need the local external-file
     * snapshot flow, which reads this Mac's disk, so a remote window refuses it until the SSH Host serves external
     * files.
     */
    'outside_projects',
]);

export type TerminalFileLinkRefusalReason = z.infer<typeof terminalFileLinkRefusalReasonSchema>;

const terminalFileLinkCanceledSchema = canceledResultSchema.extend({
    reason: terminalFileLinkRefusalReasonSchema.optional(),
});

/**
 * Result of opening a resolved Terminal file link, shared by every caller (the ordinary `terminal.openFileLink` and the
 * Caxri Bot's `caxriBot.openFileLink`) so a new opener never redefines this shape.
 */
export const terminalFileLinkOpenResultSchema = z.union([
    terminalFileLinkCanceledSchema,
    /**
     * A file outside every Project that the user chose to open: Main already read one bounded read-only snapshot, and
     * the Renderer shows it as an ephemeral tab in the target Session. This variant must precede the bare `{ opened:
     * true }` shape: `z.union` takes the first match and a plain `z.object` strips unknown keys, so the wrong order
     * silently drops `document` from the reply.
     */
    z.object({
        opened: z.literal(true),
        document: externalEditorDocumentSchema,
        sessionId: identifierSchema,
    }),
    z.object({ opened: z.literal(true) }),
    terminalFileLinkAmbiguousResultSchema,
]);

/**
 * The Main-owned open that consumes Server Core's resolution below.
 */
export const terminalFileLinkMethods = {
    'terminal.openFileLink': {
        ...desktopControl,
        params: z.object({
            terminalId: identifierSchema,
            target: z.string().min(3).max(4_096),
            location: editorNavigationTargetSchema.optional(),
        }),
        result: terminalFileLinkOpenResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Server Core resolution used only by Main; the Renderer never sees a resolved path.
 */
export const terminalFileLinkInternalMethods = {
    'terminal.fileLink.resolve': {
        ...serverControl,
        params: z.object({
            terminalId: identifierSchema,
            target: z.string().min(3).max(4_096),
        }),
        result: z.discriminatedUnion('status', [
            /**
             * An explicit path outside every Project. Server Core has not read it; Main decides whether to prompt
             * (`trusted` reflects the `security.trustedFolders` setting) and then reads one read-only snapshot itself.
             */
            z.object({
                status: z.literal('external'),
                path: pathSchema,
                sourceSessionId: identifierSchema,
                trusted: z.boolean(),
            }),
            z.object({
                status: z.literal('authorized'),
                /**
                 * What the target is. Main opens a `file` in the editor and hands a `directory` to the Files explorer.
                 * Only an exact path can be a directory; suffix-search candidates are always files.
                 */
                kind: z.enum(['file', 'directory']),
                identity: desktopOpenIdentitySchema,
                path: pathSchema,
                projectId: identifierSchema,
                sourceSessionId: identifierSchema,
            }),
            terminalFileLinkAmbiguousResolutionSchema,
        ]),
    },
} as const satisfies Record<string, MethodSpec>;
