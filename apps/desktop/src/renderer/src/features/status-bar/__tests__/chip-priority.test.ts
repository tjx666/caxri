import { describe, expect, it } from 'vitest';

import type { ChipFit, DroppableChip, HiddenChips } from '../chip-priority';
import {
    CHIP_DROP_ORDER,
    chipVisibility,
    isSameHiddenChips,
    NO_HIDDEN_CHIPS,
    resolveHiddenChips,
} from '../chip-priority';

/**
 * A bar whose never-hide items need `fixed` px, with every droppable chip `width` px wide.
 */
function fit(available: number, fixed: number, width = 50): ChipFit {
    const rendered = Object.fromEntries(CHIP_DROP_ORDER.map((chip) => [chip, width])) as Record<
        DroppableChip,
        number
    >;
    return { available, required: fixed + width * CHIP_DROP_ORDER.length, rendered };
}

function hiddenKeys(hidden: HiddenChips): DroppableChip[] {
    return hidden.keys().toArray();
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

    it('brings a hidden chip back once its remembered width fits again', () => {
        const hidden = resolveHiddenChips(fit(949, 600), NO_HIDDEN_CHIPS);
        // The hidden chip is no longer rendered: the bar now measures 50px narrower.
        const rendered: ChipFit['rendered'] = { ...fit(0, 0).rendered };
        delete rendered.childProcessCount;
        const narrower: ChipFit = { available: 949, required: 600 + 50 * 6, rendered };
        expect(hiddenKeys(resolveHiddenChips(narrower, hidden))).toEqual(['childProcessCount']);
        expect(hiddenKeys(resolveHiddenChips({ ...narrower, available: 950 }, hidden))).toEqual([]);
    });

    it('never hides a chip that renders nothing, since that frees no room', () => {
        const result = resolveHiddenChips(
            { available: 700, required: 760, rendered: { memory: 80 } },
            NO_HIDDEN_CHIPS,
        );
        expect(hiddenKeys(result)).toEqual(['memory']);
    });

    it('counts a chip that grew while visible at its new width', () => {
        const result = resolveHiddenChips(
            { available: 700, required: 720, rendered: { childProcessCount: 30, memory: 90 } },
            NO_HIDDEN_CHIPS,
        );
        expect(hiddenKeys(result)).toEqual(['childProcessCount']);
    });
});

describe('isSameHiddenChips', () => {
    it('compares which chips are hidden, not their remembered widths', () => {
        expect(isSameHiddenChips(new Map([['memory', 50]]), new Map([['memory', 51]]))).toBe(true);
        expect(isSameHiddenChips(new Map([['memory', 50]]), NO_HIDDEN_CHIPS)).toBe(false);
        expect(
            isSameHiddenChips(new Map([['memory', 50]]), new Map([['childProcessCount', 50]])),
        ).toBe(false);
    });
});

describe('chipVisibility', () => {
    it('shows every chip that is not hidden', () => {
        const visibility = chipVisibility(new Map([['memory', 50]]));
        expect(visibility.memory).toBe(false);
        expect(visibility.childProcessCount).toBe(true);
        expect(visibility.pullRequest).toBe(true);
    });
});
