import { describe, expect, it } from 'vitest';

import { logEventCatalog, logEventNames, logEventNameSchema } from '../logging.js';

describe('structured log event registry', () => {
    it('derives one schema from the grouped catalog without duplicate names', () => {
        expect(new Set(logEventNames).size).toBe(logEventNames.length);
        expect(logEventNameSchema.parse(logEventCatalog.runtime.ready)).toBe('runtime.ready');
        expect(logEventNameSchema.safeParse('runtime.typo').success).toBe(false);
    });
});
