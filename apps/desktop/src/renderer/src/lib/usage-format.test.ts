import { formatDuration, formatLimitReset, formatLimitWindowName } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { useLocaleStore } from '../i18n';
import {
    localizedDuration,
    localizedLimitReset,
    localizedLimitWindowName,
    remainingLimitPercent,
} from './usage-format';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('localized usage format', () => {
    afterEach(() => useLocaleStore.setState({ locale: 'en' }));

    it('matches the protocol English wording byte for byte', () => {
        useLocaleStore.setState({ locale: 'en' });
        for (const ms of [
            0,
            1,
            20_000,
            45 * MINUTE,
            3 * HOUR,
            3 * HOUR + 20 * MINUTE,
            1_234 * HOUR,
        ])
            expect(localizedDuration(ms)).toBe(formatDuration(ms));
        for (const minutes of [10_080, 2_880, 300, 45])
            expect(localizedLimitWindowName(minutes)).toBe(formatLimitWindowName(minutes));
        for (const ms of [-1, 0, 30 * MINUTE, 5 * HOUR, 98 * HOUR])
            expect(localizedLimitReset(ms, 0)).toBe(formatLimitReset(ms, 0));
    });

    it('words units in Simplified Chinese', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        expect(localizedDuration(3 * HOUR + 20 * MINUTE)).toBe('3 小时 20 分钟');
        expect(localizedLimitWindowName(300)).toBe('5 小时');
        expect(localizedLimitReset(98 * HOUR, 0)).toBe('4 天 2 小时后重置');
    });
});

describe('remainingLimitPercent', () => {
    it('states the share left, rounded and clamped', () => {
        expect(remainingLimitPercent(8)).toBe(92);
        expect(remainingLimitPercent(61.6)).toBe(38);
        expect(remainingLimitPercent(104)).toBe(0);
    });
});
