import { afterEach, describe, expect, it } from 'vitest';

import { setMainLanguage } from '../../locale';
import { formatTurnDuration } from '../agent-notifications';

describe('formatTurnDuration', () => {
    afterEach(() => setMainLanguage(null, []));

    it('prints compact English units', () => {
        setMainLanguage('en', []);
        expect(formatTurnDuration(0)).toBe('1s');
        expect(formatTurnDuration(125_000)).toBe('2m 5s');
        expect(formatTurnDuration(120_000)).toBe('2m');
        expect(formatTurnDuration(3_900_000)).toBe('1h 5m');
        expect(formatTurnDuration(3_600_000)).toBe('1h');
    });

    it('prints Simplified Chinese units when the interface language is Chinese', () => {
        setMainLanguage('zh-CN', []);
        expect(formatTurnDuration(15_000)).toBe('15 秒');
        expect(formatTurnDuration(125_000)).toBe('2 分 5 秒');
        expect(formatTurnDuration(120_000)).toBe('2 分钟');
        expect(formatTurnDuration(3_900_000)).toBe('1 小时 5 分');
        expect(formatTurnDuration(3_600_000)).toBe('1 小时');
    });
});
