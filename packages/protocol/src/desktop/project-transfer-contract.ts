import { z } from 'zod';

import { agentProviderSchema } from '../agent/agents.js';
import { pathSchema } from '../domain/identifiers.js';
import { terminalSurfaceSchema } from '../domain/terminal-surface.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Identifies a Caxri Projects and Sessions export. The document carries only stable, schema-independent facts so a
 * build whose database starts from a newer baseline can still read it; see docs/project-transfer.md.
 */
export const PROJECT_TRANSFER_FORMAT = 'caxri.projects';
export const PROJECT_TRANSFER_FORMAT_VERSION = 1;
/**
 * Upper bound for an import file; an export of thousands of Sessions stays far below it.
 */
export const MAX_PROJECT_TRANSFER_FILE_BYTES = 16 * 1024 * 1024;

/**
 * An Agent Terminal bound to a provider conversation. Importing it recreates a parked Terminal that resumes the same
 * conversation when the Session opens; the conversation itself stays in the provider's own store.
 */
const projectTransferTerminalSchema = z.strictObject({
    provider: agentProviderSchema,
    surface: terminalSurfaceSchema,
    /**
     * Where the Agent worked, which is where its provider stores the conversation.
     */
    cwd: pathSchema,
    agentSessionId: z.string().min(1).max(512),
    /**
     * The conversation record a Chat rewind left the conversation at, so the resumed Agent continues from that point
     * rather than from the abandoned branch after it.
     */
    resumeAt: z.string().min(1).max(512).optional(),
});

const projectTransferSessionSchema = z.strictObject({
    title: z.string().trim().min(1).max(200),
    titleMode: z.enum(['automatic', 'manual']),
    pinned: z.boolean(),
    /**
     * The linked worktree the Session worked in, absent when it worked in its Project's own root.
     */
    workbenchRootPath: pathSchema.optional(),
    terminals: z.array(projectTransferTerminalSchema).max(64),
});

const projectTransferProjectSchema = z.strictObject({
    rootPath: pathSchema,
    /**
     * In PrimarySidebar order, top first.
     */
    sessions: z.array(projectTransferSessionSchema).max(10_000),
});

export const projectTransferDocumentSchema = z.strictObject({
    format: z.literal(PROJECT_TRANSFER_FORMAT),
    formatVersion: z.literal(PROJECT_TRANSFER_FORMAT_VERSION),
    exportedAt: z.number().int().nonnegative(),
    /**
     * In PrimarySidebar order, top first.
     */
    projects: z.array(projectTransferProjectSchema).max(10_000),
});

/**
 * Why a Project or worktree in the file was not imported. `exists` keeps a repeated import from duplicating Sessions;
 * `restored` is a Project the user had removed from the sidebar, brought back with its own earlier Sessions instead of
 * the file's copies of them.
 */
const projectTransferSkipReasonSchema = z.enum(['missing', 'exists', 'restored']);

const projectTransferImportResultSchema = z.strictObject({
    projectCount: z.number().int().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
    skipped: z.array(
        z.strictObject({ rootPath: pathSchema, reason: projectTransferSkipReasonSchema }),
    ),
    /**
     * Imported Sessions whose worktree no longer exists; they open in their Project's own root instead.
     */
    missingWorkbenchRoots: z.array(pathSchema),
});

const projectTransferExportResultSchema = z.strictObject({
    path: z.string(),
    projectCount: z.number().int().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
});

export type ProjectTransferDocument = z.infer<typeof projectTransferDocumentSchema>;
export type ProjectTransferSession = z.infer<typeof projectTransferSessionSchema>;
export type ProjectTransferTerminal = z.infer<typeof projectTransferTerminalSchema>;
export type ProjectTransferImportResult = z.infer<typeof projectTransferImportResultSchema>;
export type ProjectTransferExportResult = z.infer<typeof projectTransferExportResultSchema>;

/**
 * Exporting and importing Projects and Sessions. Main owns the native save and open dialogs, then hands the chosen path
 * to Server Core, which alone reads the database. Each result is `null` when the user dismissed the dialog.
 */
export const projectTransferDesktopMethods = {
    'projectTransfer.export': {
        ...commandPolicy('desktop', 'write'),
        params: z.object({}).default({}),
        result: projectTransferExportResultSchema.nullable(),
    },
    'projectTransfer.import': {
        ...commandPolicy('desktop', 'write'),
        params: z.object({}).default({}),
        result: projectTransferImportResultSchema.nullable(),
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Server Core's half, reachable only from Desktop Main after the user picked the file.
 */
export const projectTransferInternalMethods = {
    'projectTransfer.exportPath': {
        ...commandPolicy('server', 'write'),
        params: z.object({ destination: pathSchema }),
        result: projectTransferExportResultSchema,
    },
    'projectTransfer.importPath': {
        ...commandPolicy('server', 'write'),
        params: z.object({ path: pathSchema }),
        result: projectTransferImportResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;
