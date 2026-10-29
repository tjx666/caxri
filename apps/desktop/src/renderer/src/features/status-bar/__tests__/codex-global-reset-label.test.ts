import type { AgentAvailability, CodexGlobalReset } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { codexGlobalResetChipCopy, isCodexAvailable } from '../codex-global-reset-label';

const NOW = Date.parse('2026-01-02T03:00:00.000Z');

function scheduled(overrides: Partial<Extract<CodexGlobalReset, { state: 'scheduled' }>> = {}) {
    return {
        state: 'scheduled',
        checkedAt: NOW,
        targetAt: NOW + (2 * 60 + 14) * 60_000,
        targetKind: 'deadline',
        announcedAt: NOW - 60 * 60_000,
        quote: 'Lands by midnight PST.',
        postUrl: 'https://x.com/example/status/1',
        ...overrides,
    } satisfies CodexGlobalReset;
}

const formatTime = (at: number) => new Date(at).toISOString();

describe('Codex global reset chip copy', () => {
    it('counts down to a deadline and links the announcement and the data source', () => {
        const copy = codexGlobalResetChipCopy(scheduled(), NOW, translate, formatTime);
        expect(copy?.label).toBe('Codex reset within 2h 14m');
        expect(copy?.postUrl).toBe('https://x.com/example/status/1');
        expect(copy?.tooltip.rows).toEqual([
            { label: 'Announcement', value: 'Lands by midnight PST.' },
            { label: 'Lands by', value: '2026-01-02T05:14:00.000Z' },
            { label: 'Announced', value: '2026-01-02T02:00:00.000Z' },
        ]);
        expect(copy?.tooltip.links?.items).toEqual([
            { label: 'Announcement on X', href: 'https://x.com/example/status/1' },
            { label: 'Data: codex-reset.com', href: 'https://codex-reset.com/' },
        ]);
    });

    it('words an exact target time and omits an empty quote', () => {
        const copy = codexGlobalResetChipCopy(
            scheduled({ targetKind: 'exact', quote: '' }),
            NOW,
            translate,
            formatTime,
        );
        expect(copy?.label).toBe('Codex reset in 2h 14m');
        expect(copy?.tooltip.rows?.map((row) => row.label)).toEqual(['Lands at', 'Announced']);
    });

    it('hides without a pending announcement or once the target time is reached', () => {
        expect(codexGlobalResetChipCopy(undefined, NOW, translate)).toBeUndefined();
        expect(
            codexGlobalResetChipCopy({ state: 'none', checkedAt: NOW }, NOW, translate),
        ).toBeUndefined();
        expect(
            codexGlobalResetChipCopy(
                { state: 'unavailable', checkedAt: NOW, reason: 'network' },
                NOW,
                translate,
            ),
        ).toBeUndefined();
        expect(
            codexGlobalResetChipCopy(scheduled({ targetAt: NOW }), NOW, translate),
        ).toBeUndefined();
    });
});

describe('isCodexAvailable', () => {
    it('is true only when Caxri found the Codex CLI', () => {
        const availability = (isAvailable: boolean) =>
            ({
                providers: [{ kind: 'codex', available: isAvailable }],
            }) as unknown as AgentAvailability;
        expect(isCodexAvailable(availability(true))).toBe(true);
        expect(isCodexAvailable(availability(false))).toBe(false);
        expect(isCodexAvailable({ providers: [] })).toBe(false);
    });
});
