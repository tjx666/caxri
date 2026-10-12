import { describe, expect, it } from 'vitest';

import { MobileGatewayRequestError, MobileGatewayTimeoutError } from '../mobile-gateway-errors';
import { classifyMobileWriteFailure } from '../mobile-write-failure';

describe('classifyMobileWriteFailure', () => {
    it('treats only explicit refusal codes as rejected', () => {
        for (const code of ['CAPACITY', 'CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION'])
            expect(classifyMobileWriteFailure(new MobileGatewayRequestError(code, 'raw'))).toEqual({
                kind: 'rejected',
                code,
            });
    });

    it('keeps a failure that may follow the Server acting as unknown', () => {
        expect(
            classifyMobileWriteFailure(new MobileGatewayRequestError('UNAVAILABLE', 'raw')),
        ).toEqual({ kind: 'unknown' });
        expect(
            classifyMobileWriteFailure(new MobileGatewayRequestError('INTERNAL', 'raw')),
        ).toEqual({
            kind: 'unknown',
        });
        expect(classifyMobileWriteFailure(new MobileGatewayTimeoutError())).toEqual({
            kind: 'unknown',
        });
        expect(classifyMobileWriteFailure(new Error('socket closed'))).toEqual({ kind: 'unknown' });
        expect(classifyMobileWriteFailure('rejected primitive')).toEqual({ kind: 'unknown' });
    });

    it('recognizes a request that never left the phone', () => {
        expect(classifyMobileWriteFailure(new Error('Caxri is reconnecting.'))).toEqual({
            kind: 'offline',
        });
    });
});
