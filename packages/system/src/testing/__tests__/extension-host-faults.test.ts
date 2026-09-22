import { describe, expect, it } from 'vitest';

import {
    ACCEPTANCE_EXTENSION_HOST_FAULT_SEQUENCE,
    acceptanceExtensionHostFaultCaseIds,
    EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY,
    extensionHostProtocolFaults,
    resolveExtensionHostProtocolFaults,
} from '../extension-host-faults';

const key = EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY;

describe('resolveExtensionHostProtocolFaults', () => {
    it('stays empty outside an E2E launch even when a valid sequence is requested', () => {
        expect(resolveExtensionHostProtocolFaults({ [key]: 'child-envelope' })).toEqual([]);
        expect(
            resolveExtensionHostProtocolFaults({ CAXRI_E2E: '0', [key]: 'child-envelope' }),
        ).toEqual([]);
    });

    it('stays empty when an E2E launch requests nothing', () => {
        expect(resolveExtensionHostProtocolFaults({ CAXRI_E2E: '1' })).toEqual([]);
        expect(
            resolveExtensionHostProtocolFaults({ CAXRI_E2E: '1', [key]: ' '.repeat(3) }),
        ).toEqual([]);
    });

    it('resolves the closed reasons in the requested order', () => {
        expect(
            resolveExtensionHostProtocolFaults({
                CAXRI_E2E: '1',
                [key]: 'reply-result, parent-envelope ,child-envelope',
            }),
        ).toEqual(['reply-result', 'parent-envelope', 'child-envelope']);
    });

    it('discards the whole sequence when any entry is outside the closed set', () => {
        expect(
            resolveExtensionHostProtocolFaults({
                CAXRI_E2E: '1',
                [key]: 'child-envelope,rm -rf /',
            }),
        ).toEqual([]);
        expect(
            resolveExtensionHostProtocolFaults({ CAXRI_E2E: '1', [key]: 'Parent-Envelope' }),
        ).toEqual([]);
    });

    it('publishes an admitted-case sequence covering every reason exactly once', () => {
        expect(acceptanceExtensionHostFaultCaseIds.has('audit-extension-message-reasons')).toBe(
            true,
        );
        expect(
            resolveExtensionHostProtocolFaults({
                CAXRI_E2E: '1',
                [key]: ACCEPTANCE_EXTENSION_HOST_FAULT_SEQUENCE,
            }),
        ).toEqual([...extensionHostProtocolFaults]);
    });
});
