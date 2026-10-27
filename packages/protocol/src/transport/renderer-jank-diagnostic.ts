import { z } from 'zod';

/**
 * Script attribution is limited to Caxri's own bundle: a chunk file name and a function identifier. Anything that could
 * carry a path, a user string, or an extension URL fails the pattern and is replaced by `null` before it is reported.
 */
const bundleFileNameSchema = z
    .string()
    .regex(/^[\w.-]{1,80}$/u)
    .nullable();
const functionIdentifierSchema = z
    .string()
    .regex(/^[\w$.]{1,64}$/u)
    .nullable();

const durationMsSchema = z.number().int().nonnegative().max(600_000);

export const longAnimationFrameInvokerTypes = [
    'classic-script',
    'event-listener',
    'module-script',
    'reaction',
    'reject-promise',
    'resolve-promise',
    'unknown',
    'user-callback',
] as const;

/**
 * One Long Animation Frame at or above the reporting threshold, with the script that spent the most time in it.
 * `endedAgoMs` counts back from the moment the batch was sent, so a reader can place the frame against the log record's
 * own timestamp and against Server records without a shared clock.
 */
export const slowAnimationFrameSchema = z.strictObject({
    durationMs: durationMsSchema,
    endedAgoMs: durationMsSchema,
    blockingMs: durationMsSchema,
    styleLayoutMs: durationMsSchema,
    isDuringSessionSwitch: z.boolean(),
    scriptCount: z.number().int().nonnegative().max(10_000),
    topScript: z
        .strictObject({
            invokerType: z.enum(longAnimationFrameInvokerTypes),
            durationMs: durationMsSchema,
            forcedStyleLayoutMs: durationMsSchema,
            file: bundleFileNameSchema,
            functionName: functionIdentifierSchema,
        })
        .nullable(),
});

/**
 * A Session switch measured from the select gesture to the next paint after the Workbench converged, split into the
 * Server round trip, the wait for the resulting state to apply, and the time to the next frame. Convergence is itself a
 * full `app.bootstrap` read plus the Renderer's apply, so `snapshotMs` (reply to snapshot arrival, including any read
 * already in flight) and `applyMs` (arrival to applied) split it when the arrival was observed.
 */
export const slowSessionSwitchSchema = z.strictObject({
    totalMs: durationMsSchema,
    endedAgoMs: durationMsSchema,
    requestMs: durationMsSchema,
    convergeMs: durationMsSchema,
    snapshotMs: durationMsSchema.optional(),
    applyMs: durationMsSchema.optional(),
    paintMs: durationMsSchema,
});

/**
 * A batch of Renderer responsiveness samples that crossed their threshold. Nothing is sent while switches and frames
 * stay fast, and batches are rate limited, so the channel carries timings only: no DOM text, titles, paths, or ids of
 * user content.
 */
export const rendererJankDiagnosticSchema = z.strictObject({
    kind: z.literal('renderer-jank'),
    diagnosticId: z.uuid(),
    documentVisible: z.boolean(),
    frames: z.array(slowAnimationFrameSchema).max(5),
    omittedFrameCount: z.number().int().nonnegative().max(1_000_000),
    switches: z.array(slowSessionSwitchSchema).max(5),
    omittedSwitchCount: z.number().int().nonnegative().max(1_000_000),
});

export type LongAnimationFrameInvokerType = (typeof longAnimationFrameInvokerTypes)[number];
export type SlowAnimationFrame = z.infer<typeof slowAnimationFrameSchema>;
export type SlowSessionSwitch = z.infer<typeof slowSessionSwitchSchema>;
export type RendererJankDiagnostic = z.infer<typeof rendererJankDiagnosticSchema>;
