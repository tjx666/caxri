import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

export const MAX_LINK_PREVIEW_TITLE_LENGTH = 300;
export const MAX_LINK_PREVIEW_DESCRIPTION_LENGTH = 500;
export const MAX_LINK_PREVIEW_URL_LENGTH = 2048;

const httpsUrl = z
    .string()
    .max(MAX_LINK_PREVIEW_URL_LENGTH)
    .regex(/^https:\/\/\S+$/u);

export const linkPreviewDesktopMethods = {
    /**
     * The page summary a transcript link's hover card shows: the title, description, and share image the page declares
     * in its Open Graph or Twitter Card tags, falling back to `<title>` and the description meta tag. Main reads only
     * the start of the page through Chromium's network stack, like `links.favicon`. An HTTPS URL only; every field is
     * absent when the page is unreachable, not HTML, or declares nothing, and the card then shows the host alone.
     */
    'links.preview': {
        ...commandPolicy('desktop', 'read'),
        params: z.strictObject({ url: httpsUrl }),
        result: z.strictObject({
            title: z.string().max(MAX_LINK_PREVIEW_TITLE_LENGTH).optional(),
            description: z.string().max(MAX_LINK_PREVIEW_DESCRIPTION_LENGTH).optional(),
            /**
             * An absolute HTTPS URL the Renderer loads as an `<img>`; the CSP already admits HTTPS images.
             */
            imageUrl: httpsUrl.optional(),
        }),
    },
} as const satisfies Record<string, MethodSpec>;
