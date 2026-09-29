import { describe, expect, it } from 'vitest';

import { requestFailureLogLevel, shouldLogSuccessfulRequest } from '../request-observability';

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

describe('requestFailureLogLevel', () => {
    it('records a file read racing a delete as a caller-handled outcome, not a Caxri fault', () => {
        expect(requestFailureLogLevel('files.read', 'NOT_FOUND')).toBe('warn');
        expect(requestFailureLogLevel('files.read', 'IO')).toBe('error');
    });

    it('keeps NOT_FOUND an error for methods whose caller cannot expect it', () => {
        expect(requestFailureLogLevel('terminal.attach', 'NOT_FOUND')).toBe('error');
        expect(requestFailureLogLevel('session.updateState', 'CONFLICT')).toBe('warn');
    });
});
