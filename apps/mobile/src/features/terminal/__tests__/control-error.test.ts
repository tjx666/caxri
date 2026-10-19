import { describe, expect, it } from 'vitest';

import { MobileGatewayRequestError } from '../../connection/mobile-gateway-client';
import { MobileGatewayTimeoutError } from '../../connection/mobile-gateway-errors';
import { terminalControlError } from '../control-error';

describe('terminalControlError', () => {
    it('keeps Terminal wording for forbidden and conflicting control', () => {
        expect(terminalControlError(new MobileGatewayRequestError('FORBIDDEN', 'Denied'))).toBe(
            'This device cannot control the Terminal. Pair it again with control access.',
        );
        expect(terminalControlError(new MobileGatewayRequestError('CONFLICT', 'Moved'))).toBe(
            'The Terminal changed. Reopen it before sending.',
        );
    });

    it('never shows the Server English detail for another code', () => {
        const message = terminalControlError(
            new MobileGatewayRequestError('INTERNAL', 'pty write failed: EPIPE'),
        );
        expect(message).not.toContain('EPIPE');
        expect(message).toBe("Couldn't confirm delivery. Check the Terminal before sending again.");
    });

    it('says delivery is unconfirmed when the request timed out', () => {
        expect(terminalControlError(new MobileGatewayTimeoutError())).toBe(
            "Couldn't confirm delivery. Check the Terminal before sending again.",
        );
    });
});
