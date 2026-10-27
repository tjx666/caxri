import { describe, expect, it } from 'vitest';

import type { ChipFit, DroppableChip, HiddenChips } from '../chip-priority';
import {
    CHIP_DROP_ORDER,
    chipDropOrder,
    chipVisibility,
    isChipQueryUnread,
    isSameHiddenChips,
    NO_HIDDEN_CHIPS,
    resolveHiddenChips,
} from '../chip-priority';

/**
 * A bar whose never-hide items need `fixed` px, with every droppable chip `width` px wide and shown.
 */
function fit(available: number, fixed: number, width = 50): ChipFit {
    const chips = Object.fromEntries(CHIP_DROP_ORDER.map((chip) => [chip, width])) as Record<
        DroppableChip,
        number
    >;
    return { available, required: fixed + width * CHIP_DROP_ORDER.length, chips };
}

function hiddenKeys(hidden: HiddenChips): DroppableChip[] {
    return [...hidden];
}

/**
 * The chips a fresh bar hides at `available` px with `fixed` px of never-hide items.
 */
function hiddenAt(available: number, fixed: number): DroppableChip[] {
    return hiddenKeys(resolveHiddenChips(fit(available, fixed), NO_HIDDEN_CHIPS));
}

describe('resolveHiddenChips', () => {
    it('hides nothing while the content fits', () => {
        expect(hiddenAt(1_000, 600)).toEqual([]);
        expect(hiddenAt(950, 600)).toEqual([]);
    });

    it('drops whole chips lowest priority first until the content fits', () => {
        expect(hiddenAt(949, 600)).toEqual(['childProcessCount']);
        expect(hiddenAt(860, 600)).toEqual(['childProcessCount', 'memory']);
        expect(hiddenAt(600, 600)).toEqual(CHIP_DROP_ORDER);
    });

    it('keeps every chip hidden but never truncates when even the never-hide items overflow', () => {
        expect(hiddenAt(400, 600)).toEqual(CHIP_DROP_ORDER);
    });

    it('brings a hidden chip back once its measured width fits again', () => {
        const hidden = resolveHiddenChips(fit(949, 600), NO_HIDDEN_CHIPS);
        // The hidden chip is out of the flow: the bar's content now measures 50px narrower, the chip itself still 50px.
        const narrower: ChipFit = { ...fit(949, 600), required: 600 + 50 * 6 };
        expect(hiddenKeys(resolveHiddenChips(narrower, hidden))).toEqual(['childProcessCount']);
        expect(hiddenKeys(resolveHiddenChips({ ...narrower, available: 950 }, hidden))).toEqual([]);
    });

    it('shows the chips that fit once a hidden chip has nothing left to show', () => {
        // 560px of never-hide items in 610px: the 80px output speed has to go along with the two process chips.
        const hidden = resolveHiddenChips(
            {
                available: 610,
                required: 720,
                chips: { childProcessCount: 40, memory: 40, agentThroughput: 80 },
            },
            NO_HIDDEN_CHIPS,
        );
        expect(hiddenKeys(hidden)).toEqual(['childProcessCount', 'memory', 'agentThroughput']);
        // The Agent exits while its output speed is hidden: the chip measures as absent, so memory fits again.
        const exited = resolveHiddenChips(
            { available: 610, required: 560, chips: { childProcessCount: 40, memory: 40 } },
            hidden,
        );
        expect(hiddenKeys(exited)).toEqual(['childProcessCount']);
    });

    it('never hides a chip that renders nothing, since that frees no room', () => {
        const result = resolveHiddenChips(
            { available: 700, required: 760, chips: { memory: 80 } },
            NO_HIDDEN_CHIPS,
        );
        expect(hiddenKeys(result)).toEqual(['memory']);
    });

    it('counts a chip that grew while visible at its new width', () => {
        const result = resolveHiddenChips(
            { available: 700, required: 720, chips: { childProcessCount: 30, memory: 90 } },
            NO_HIDDEN_CHIPS,
        );
        expect(hiddenKeys(result)).toEqual(['childProcessCount']);
    });
});

describe('urgent chips', () => {
    it('drops a warning chip after every calm chip', () => {
        expect(chipDropOrder(new Set(['agentUsage']))).toEqual([
            'childProcessCount',
            'memory',
            'agentThroughput',
            'linearIssue',
            'acceptance',
            'pullRequest',
            'agentUsage',
        ]);
        expect(chipDropOrder(undefined)).toEqual(CHIP_DROP_ORDER);
    });

    it('keeps the urgent usage chip while lower-value chips are hidden to make room', () => {
        const base = fit(420, 300);
        const calm = resolveHiddenChips(base, NO_HIDDEN_CHIPS);
        const urgent = resolveHiddenChips(
            { ...base, urgent: new Set(['agentUsage']) },
            NO_HIDDEN_CHIPS,
        );
        expect(hiddenKeys(calm)).toContain('agentUsage');
        expect(hiddenKeys(urgent)).not.toContain('agentUsage');
        expect(hiddenKeys(urgent)).toContain('linearIssue');
    });
});

describe('isSameHiddenChips', () => {
    it('compares which chips are hidden', () => {
        expect(isSameHiddenChips(new Set(['memory']), new Set(['memory']))).toBe(true);
        expect(isSameHiddenChips(new Set(['memory']), NO_HIDDEN_CHIPS)).toBe(false);
        expect(isSameHiddenChips(new Set(['memory']), new Set(['childProcessCount']))).toBe(false);
    });
});

describe('chipVisibility', () => {
    it('shows every chip that is not hidden', () => {
        const visibility = chipVisibility(new Set(['memory']));
        expect(visibility.memory).toBe(false);
        expect(visibility.childProcessCount).toBe(true);
        expect(visibility.pullRequest).toBe(true);
    });
});

describe('isChipQueryUnread', () => {
    it('keeps a shared query polling while any chip it feeds is shown', () => {
        // The window first drops the child-process count; memory still reads `terminal.resources`.
        expect(isChipQueryUnread({ childProcessCount: false, memory: true })).toBe(false);
        expect(isChipQueryUnread({ childProcessCount: false, memory: false })).toBe(true);
    });

    it('pauses a single-chip query exactly while its chip is hidden', () => {
        expect(isChipQueryUnread({ agentThroughput: true })).toBe(false);
        expect(isChipQueryUnread({ agentThroughput: false })).toBe(true);
    });
});
