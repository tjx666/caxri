import { describe, expect, it } from 'vitest';

import {
    extensionViewMethods,
    extensionViewOperationMetadata,
    extensionViewOperationNames,
    extensionViewOperationNameSchema,
    extensionViewOperationResultSchemas,
    extensionViewOperationSchema,
    isExtensionViewReadOperation,
} from '../view-methods';

const expectedOperations = [
    'badge.snapshot',
    'source.snapshot',
    'source.historyPage',
    'source.historyDetails',
    'source.action',
] as const;

describe('controlled view operation metadata', () => {
    it('covers every public operation with its provider and lifecycle policy', () => {
        expect(extensionViewOperationNames).toEqual(expectedOperations);
        expect(extensionViewOperationNameSchema.options).toEqual(expectedOperations);
        expect(Object.keys(extensionViewOperationMetadata)).toEqual(expectedOperations);

        for (const operation of expectedOperations) {
            const metadata = extensionViewOperationMetadata[operation];
            expect(isExtensionViewReadOperation(operation)).toBe(
                metadata.cancellation === 'reject',
            );
        }
        expect(extensionViewOperationMetadata['badge.snapshot']).toEqual({
            provider: 'badge',
            cancellation: 'reject',
            lifetime: 'expiring',
        });
        expect(extensionViewOperationMetadata['source.action']).toEqual({
            provider: 'source',
            cancellation: 'authoritative',
            lifetime: 'non-expiring',
        });
    });

    it('keeps the public parameter and result unions aligned with the complete maps', () => {
        expect(
            extensionViewOperationSchema.options.map((option) => option.shape.operation.value),
        ).toEqual(extensionViewOperationNames);
        expect(extensionViewMethods['viewContainers.viewOperation'].result.options).toEqual(
            Object.values(extensionViewOperationResultSchemas),
        );
    });
});
