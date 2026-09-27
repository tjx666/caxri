import { describe, expect, it } from 'vitest';

import {
    extensionViewOperationMetadata,
    extensionViewOperationNames,
} from '../../registry/view-methods';
import { isNonExpiringServerOperation, isNonExpiringViewOperation } from '../request-lifetime';

describe('isNonExpiringServerOperation', () => {
    it('allows the documented non-expiring methods', () => {
        for (const method of [
            'agent.dispatch.wait',
            'agent.dispatch.waitInternal',
            'agent.delegation.wait',
            'agent.delegation.waitInternal',
            'agent.message.wait',
        ])
            expect(isNonExpiringServerOperation(method)).toBe(true);
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
        expect(isNonExpiringServerOperation('agent.delegation.status')).toBe(false);
        expect(isNonExpiringServerOperation('agent.dispatch.start')).toBe(false);
        expect(isNonExpiringServerOperation('files.read')).toBe(false);
        expect(isNonExpiringServerOperation('terminal.send')).toBe(false);
        expect(isNonExpiringServerOperation('')).toBe(false);
    });
});

describe('isNonExpiringViewOperation', () => {
    it('derives view lifetimes from the shared operation policy', () => {
        for (const operation of extensionViewOperationNames)
            expect(isNonExpiringViewOperation(operation)).toBe(
                extensionViewOperationMetadata[operation].lifetime === 'non-expiring',
            );
        expect(isNonExpiringViewOperation('git.sync')).toBe(true);
        expect(isNonExpiringViewOperation('git.discard')).toBe(true);
        expect(isNonExpiringViewOperation('files.list')).toBe(false);
    });
});
