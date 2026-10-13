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

    it('words units in English', () => {
        useLocaleStore.setState({ locale: 'en' });
        expect(
            [0, 1, 20_000, 45 * MINUTE, 3 * HOUR, 3 * HOUR + 20 * MINUTE, 1_234 * HOUR].map((ms) =>
                localizedDuration(ms),
            ),
        ).toEqual(['0m', '<1m', '<1m', '45m', '3h', '3h 20m', '1,234h']);
        expect(
            [10_080, 2_880, 300, 45].map((minutes) => localizedLimitWindowName(minutes)),
        ).toEqual(['Weekly', '2-day', '5-hour', '45-minute']);
        expect(
            [-1, 0, 30 * MINUTE, 5 * HOUR, 98 * HOUR].map((ms) => localizedLimitReset(ms, 0)),
        ).toEqual(['resets now', 'resets now', 'resets in 30m', 'resets in 5h', 'resets in 4d 2h']);
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
