import { z } from 'zod';

import { themeImportWarningSchema, themeTokensSchema } from '../domain/domain.js';
import { pathSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { configurationSourceSchema as configSourceSchema } from './configuration-contract.js';
import { MAX_IMPORTED_THEMES } from './theme-appearance.js';

const noParameters = z.object({}).default({});

/**
 * `imported` is the catalog of themes saved by Import Theme, which the "Follow system appearance" slots can name.
 */
const themeResult = z.object({
    value: themeTokensSchema,
    source: configSourceSchema,
    imported: z.array(themeTokensSchema).max(MAX_IMPORTED_THEMES),
});
const themeImportResult = z.object({
    value: themeTokensSchema,
    warnings: z.array(themeImportWarningSchema),
});

export const themeMethods = {
    'theme.get': { ...commandPolicy('server', 'read'), params: noParameters, result: themeResult },
    'theme.update': {
        ...commandPolicy('server', 'write'),
        params: z.object({ source: configSourceSchema }),
        result: themeResult,
    },
    'theme.import': {
        ...commandPolicy('desktop', 'write'),
        params: noParameters,
        result: themeImportResult.nullable(),
    },
    /**
     * Deletes one imported theme. A light or dark slot that named it goes back to that appearance's default preset.
     */
    'theme.removeImported': {
        ...commandPolicy('server', 'write'),
        params: z.object({ id: z.string().min(1).max(128) }),
        result: themeResult,
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Desktop's `theme.import` reads the file the user picked through this Server method.
 */
export const themeInternalMethods = {
    'theme.importPath': {
        ...commandPolicy('server', 'write'),
        params: z.object({ path: pathSchema }),
        result: themeImportResult,
    },
} as const satisfies Record<string, MethodSpec>;
