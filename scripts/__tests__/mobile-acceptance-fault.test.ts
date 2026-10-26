import { describe, expect, it } from 'vitest';

import { mobileAcceptanceFaultEnvironment } from '../mobile-acceptance-fault';

describe('mobileAcceptanceFaultEnvironment', () => {
    it('bakes a case fault in only when that case runs alone', () => {
        expect(mobileAcceptanceFaultEnvironment(['MOB-CHAT-SEND-UNKNOWN-01'])).toEqual({
            EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT: 'chat-send-unknown-once',
        });
        expect(mobileAcceptanceFaultEnvironment(['MOB-STORAGE-01'])).toEqual({
            EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT: 'storage-read-once',
        });
        expect(mobileAcceptanceFaultEnvironment(['MOB-RENDER-01'])).toEqual({
            EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT: 'render-once',
        });
        expect(mobileAcceptanceFaultEnvironment(['MOB-RENDER-01', 'MOB-CHAT-01'])).toEqual({});
        expect(mobileAcceptanceFaultEnvironment(['MOB-CHAT-01'])).toEqual({});
        expect(mobileAcceptanceFaultEnvironment(['constructor'])).toEqual({});
    });
});
