import { relativeTime } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import { localizedRelativeTime } from './relative-time';

const NOW = Date.UTC(2026, 0, 15, 12);

describe('localizedRelativeTime', () => {
    it('keeps the shared English wording', () => {
        for (const offset of [5_000, 3 * 60_000, 2 * 3_600_000, 3 * 86_400_000])
            for (const style of ['long', 'narrow'] as const)
                expect(localizedRelativeTime(NOW - offset, NOW, style, 'en')).toBe(
                    relativeTime(NOW - offset, NOW, style),
                );
    });

    it('formats Simplified Chinese with the same unit thresholds', () => {
        expect(localizedRelativeTime(NOW - 3 * 60_000, NOW, 'long', 'zh-CN')).toBe('3分钟前');
        expect(localizedRelativeTime(NOW - 2 * 3_600_000, NOW, 'narrow', 'zh-CN')).toBe('2小时前');
        expect(localizedRelativeTime(NOW - 86_400_000, NOW, 'long', 'zh-CN')).toBe('昨天');
    });
});
