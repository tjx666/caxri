import { describe, expect, it } from 'vitest';

import { processTreeRSSKiB } from './ci-metrics';

describe('CI command metrics', () => {
    it('adds the root process and recursive descendants without unrelated RSS', () => {
        const snapshot = `
          10 1 100
          11 10 200
          12 11 300
          99 1 900
        `;

        expect(processTreeRSSKiB(snapshot, 10)).toBe(600);
        expect(processTreeRSSKiB(snapshot, 99)).toBe(900);
        expect(processTreeRSSKiB(snapshot, 404)).toBeUndefined();
    });
});
