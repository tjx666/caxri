import { describe, expect, it } from 'vitest';

import { logEventCatalog, logEventNames, logEventNameSchema } from '../logging.js';

describe('structured log event registry', () => {
    it('derives one schema from the grouped catalog without duplicate names', () => {
        expect(new Set(logEventNames).size).toBe(logEventNames.length);
        expect(logEventNameSchema.parse(logEventCatalog.serverCore.ready)).toBe(
            'server_core.ready',
        );
        expect(logEventNameSchema.safeParse('server_core.typo').success).toBe(false);
    });
});
