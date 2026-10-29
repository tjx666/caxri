import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../../i18n/locale-store';
import { mobileErrorMessage, MobileLocalizedError } from '../mobile-error-message';
import { MobileGatewayRequestError, MobileGatewayTimeoutError } from '../mobile-gateway-errors';

describe('mobileErrorMessage', () => {
    afterEach(() => setLocale('en'));

    it('translates a known Server error code instead of showing its English message', () => {
        setLocale('zh-CN');
        const error = new MobileGatewayRequestError('NOT_FOUND', 'Inbox item not found');
        expect(mobileErrorMessage(error, '无法发送回复。')).toBe('该项目在电脑上已不存在。');
        expect(mobileErrorMessage(new MobileGatewayTimeoutError(), 'x')).toBe(
            'Caxri 未及时响应。请确认电脑上的 Caxri 正在运行，然后重试。',
        );
    });

    it('uses the entry fallback for an unknown code or a foreign error', () => {
        setLocale('zh-CN');
        expect(
            mobileErrorMessage(new MobileGatewayRequestError('INTERNAL', 'boom'), '无法发送回复。'),
        ).toBe('无法发送回复。');
        expect(mobileErrorMessage(new Error('Network request failed'), '无法发送回复。')).toBe(
            '无法发送回复。',
        );
        expect(mobileErrorMessage('nope', 'fallback')).toBe('fallback');
    });

    it('keeps a message the phone already translated', () => {
        expect(mobileErrorMessage(new MobileLocalizedError('Clipboard is empty'), 'fallback')).toBe(
            'Clipboard is empty',
        );
    });

    it('answers in English under the English locale', () => {
        expect(mobileErrorMessage(new MobileGatewayRequestError('FORBIDDEN', 'x'), 'f')).toBe(
            'This phone is not allowed to do that.',
        );
    });
});
