import { z } from 'zod';

const viewBadgeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const viewBadgeDescriptionSchema = z.string().min(1).max(2_048);

/**
 * An extension reports what the activity means, never how it looks: the Workbench owns the icon, the fill, the digit
 * cap, and how badges from several views in one container combine.
 *
 * Severity and tally are mutually exclusive, and the union enforces it rather than the Renderer: `count` is a plain
 * tally with no severity, and `error` and `warning` carry no `count` field at all. A badge that is both would have to
 * draw a digit where its glyph goes, leaving the fill as the only thing separating "5 changes" from "5 failures", which
 * is nothing to a colorblind user or in a greyscale capture. This mirrors VS Code, whose `ErrorBadge` and
 * `WarningBadge` extend `IconBadge` and likewise have no number
 * (`src/vs/workbench/services/activity/common/activity.ts`). A severity provider says how many in `description`, which
 * the Workbench publishes in the tab's tooltip and accessible description either way.
 */
export const viewBadgeSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('count'),
        count: viewBadgeCountSchema,
        description: viewBadgeDescriptionSchema,
    }),
    z.object({
        kind: z.enum(['error', 'warning']),
        description: viewBadgeDescriptionSchema,
    }),
]);

export type ViewBadge = z.infer<typeof viewBadgeSchema>;
