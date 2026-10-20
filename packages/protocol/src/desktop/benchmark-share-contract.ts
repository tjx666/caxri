import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Upper bound on a share card PNG carried over IPC as base64. A 2x card of a few hundred kilobytes is typical; the
 * ceiling only keeps a runaway raster from flooding Main.
 */
const BENCHMARK_SHARE_IMAGE_BASE64_LIMIT = 24 * 1024 * 1024;

const benchmarkShareImage = z.object({
    /**
     * The rasterized card as base64 PNG bytes (no data-URL prefix).
     */
    pngBase64: z.string().min(1).max(BENCHMARK_SHARE_IMAGE_BASE64_LIMIT),
});

/**
 * Main's half of exporting a Benchmark run as a share card: the Renderer rasterizes the card, Main owns the clipboard
 * and the native save dialog because the Renderer has neither. Nothing is uploaded and no file is written without the
 * user choosing a destination.
 */
export const benchmarkShareMethods = {
    'benchmark.shareImage.copy': {
        ...commandPolicy('desktop', 'control'),
        params: benchmarkShareImage,
        result: z.null(),
    },
    'benchmark.shareImage.save': {
        ...commandPolicy('desktop', 'write'),
        params: benchmarkShareImage.extend({
            /**
             * The suggested file name shown in the save dialog; Main keeps only its base name.
             */
            fileName: z.string().min(1).max(255),
        }),
        /**
         * The chosen path, or `null` when the user dismissed the dialog.
         */
        result: z.object({ path: z.string().min(1).max(4_096) }).nullable(),
    },
} as const satisfies Record<string, MethodSpec>;
