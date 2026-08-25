import { describe, expect, it } from 'vitest';

import { isNonExpiringRuntimeMethod, isNonExpiringViewOperation } from '../request-lifetime';

describe('isNonExpiringRuntimeMethod', () => {
    it('allows the documented non-expiring methods', () => {
        expect(isNonExpiringRuntimeMethod('agent.dispatch.waitInternal')).toBe(true);
        expect(isNonExpiringRuntimeMethod('agent.message.wait')).toBe(true);
        expect(isNonExpiringRuntimeMethod('files.copy')).toBe(true);
        expect(isNonExpiringRuntimeMethod('files.write')).toBe(true);
        expect(isNonExpiringRuntimeMethod('git.discard.apply')).toBe(true);
    });

    it('rejects representative expiring and unrelated methods', () => {
        expect(isNonExpiringRuntimeMethod('agent.dispatch.wait')).toBe(false);
        expect(isNonExpiringRuntimeMethod('agent.dispatch.start')).toBe(false);
        expect(isNonExpiringRuntimeMethod('files.read')).toBe(false);
        expect(isNonExpiringRuntimeMethod('terminal.send')).toBe(false);
        expect(isNonExpiringRuntimeMethod('')).toBe(false);
    });
});

describe('isNonExpiringViewOperation', () => {
    it('keeps durable Files and Git mutations on their authoritative completion path', () => {
        for (const operation of [
            'files.create',
            'files.copy',
            'files.rename',
            'files.move',
            'files.operation.cancel',
            'files.operation.acknowledge',
            'files.trash',
            'git.sync',
            'git.discard',
        ])
            expect(isNonExpiringViewOperation(operation)).toBe(true);
        expect(isNonExpiringViewOperation('files.list')).toBe(false);
        expect(isNonExpiringViewOperation('git.summary')).toBe(false);
    });
});
