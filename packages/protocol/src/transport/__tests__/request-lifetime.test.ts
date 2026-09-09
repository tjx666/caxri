import { describe, expect, it } from 'vitest';

import { isNonExpiringServerOperation, isNonExpiringViewOperation } from '../request-lifetime';

describe('isNonExpiringServerOperation', () => {
    it('allows the documented non-expiring methods', () => {
        expect(isNonExpiringServerOperation('agent.dispatch.waitInternal')).toBe(true);
        expect(isNonExpiringServerOperation('agent.delegation.waitInternal')).toBe(true);
        expect(isNonExpiringServerOperation('agent.message.wait')).toBe(true);
        for (const method of [
            'files.create',
            'files.copy',
            'files.rename',
            'files.move',
            'files.operation.cancel',
            'files.operation.acknowledge',
            'files.trash',
        ])
            expect(isNonExpiringServerOperation(method)).toBe(true);
        expect(isNonExpiringServerOperation('files.write')).toBe(true);
        expect(isNonExpiringServerOperation('git.discard.apply')).toBe(true);
        expect(isNonExpiringServerOperation('terminal.input')).toBe(true);
    });

    it('rejects representative expiring and unrelated methods', () => {
        expect(isNonExpiringServerOperation('agent.dispatch.wait')).toBe(false);
        expect(isNonExpiringServerOperation('agent.dispatch.start')).toBe(false);
        expect(isNonExpiringServerOperation('files.read')).toBe(false);
        expect(isNonExpiringServerOperation('terminal.send')).toBe(false);
        expect(isNonExpiringServerOperation('')).toBe(false);
    });
});

describe('isNonExpiringViewOperation', () => {
    it('keeps opaque provider actions on their authoritative completion path', () => {
        expect(isNonExpiringViewOperation('source.action')).toBe(true);
        expect(isNonExpiringViewOperation('git.sync')).toBe(true);
        expect(isNonExpiringViewOperation('git.discard')).toBe(true);
        expect(isNonExpiringViewOperation('files.list')).toBe(false);
        expect(isNonExpiringViewOperation('source.snapshot')).toBe(false);
    });
});
