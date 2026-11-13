import { z } from 'zod';

import { scopedProjectSchema } from '../domain/domain.js';
import { identifierSchema } from '../domain/identifiers.js';

const MOBILE_PROJECT_BROWSE_MAX_ENTRIES = 200;

/**
 * A Project as a phone lists it: the granted Project plus when it last saw activity.
 */
export const mobileProjectSummarySchema = scopedProjectSchema.extend({
    lastActivityAt: z.number().int().nonnegative().optional(),
});

/**
 * Accepts either a path relative to the Mac user's home directory or an opaque absolute path; the Server validates that
 * the resolved, symlink-followed target stays inside the home directory before it touches the filesystem.
 */
const mobileHomePathSchema = z.string().min(1).max(4_096);

export const mobileProjectBrowseParametersSchema = z.strictObject({
    path: mobileHomePathSchema.optional(),
});

const mobileProjectBrowseEntrySchema = z.strictObject({
    name: z.string().min(1).max(255),
    relativePath: z.string().min(1).max(4_096),
    isGitRepository: z.boolean(),
    hasChildren: z.boolean(),
});

export const mobileProjectBrowseResultSchema = z.strictObject({
    entries: z.array(mobileProjectBrowseEntrySchema).max(MOBILE_PROJECT_BROWSE_MAX_ENTRIES),
    truncated: z.boolean(),
});

export const mobileProjectAddParametersSchema = z.strictObject({ path: mobileHomePathSchema });

export const mobileProjectAddResultSchema = z.strictObject({
    project: mobileProjectSummarySchema,
});

/**
 * A phone sees only its granted Projects, so it names a neighbor rather than a global index; the Server maps the move
 * onto the full Project order Desktop's sidebar shows.
 */
export const mobileProjectReorderParametersSchema = z.strictObject({
    projectId: identifierSchema,
    anchorProjectId: identifierSchema,
    placement: z.enum(['before', 'after']),
});
