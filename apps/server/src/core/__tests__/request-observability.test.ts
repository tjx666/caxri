import { describe, expect, it } from 'vitest';

import { shouldLogSuccessfulRequest } from '../request-observability';

describe('shouldLogSuccessfulRequest', () => {
    it('drops successful Renderer polling reads at both boundaries', () => {
        for (const method of ['app.activeContext', 'terminal.resources', 'app.records']) {
            expect(shouldLogSuccessfulRequest('control', method)).toBe(false);
            expect(shouldLogSuccessfulRequest('domain', method)).toBe(false);
        }
    });

    it('keeps logging ordinary requests', () => {
        expect(shouldLogSuccessfulRequest('control', 'session.create')).toBe(true);
        expect(shouldLogSuccessfulRequest('domain', 'session.create')).toBe(true);
    });
});
