import type { TerminalKind } from '@caxri/protocol';
import { agentProviderIds, terminalKindSchema } from '@caxri/protocol';
import { create } from 'zustand';

import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';

const STORAGE_KEY = 'caxri.terminal-kind-recency';

/**
 * Declaration order from the protocol catalog, with `shell` last. It is the tail of every ordering, so a kind the user
 * has never picked keeps a stable, predictable position instead of shuffling.
 */
const CATALOG_TERMINAL_KINDS: readonly TerminalKind[] = [...agentProviderIds, 'shell'];

/**
 * Normalizes any candidate ordering into a complete, duplicate-free list of every known Terminal kind: recognized
 * entries keep their given order, unknown or repeated entries are dropped, and the kinds the list never mentioned are
 * appended in catalog order. Persisted state, a freshly promoted kind, and an empty first run therefore all produce a
 * list the menu can render directly.
 */
export function orderTerminalKindsByRecency(candidate: readonly unknown[]): TerminalKind[] {
    const ranked: TerminalKind[] = [];
    const seen = new Set<TerminalKind>();
    for (const entry of candidate) {
        const parsed = terminalKindSchema.safeParse(entry);
        if (!parsed.success || seen.has(parsed.data)) continue;
        seen.add(parsed.data);
        ranked.push(parsed.data);
    }
    return [...ranked, ...CATALOG_TERMINAL_KINDS.filter((kind) => !seen.has(kind))];
}

/**
 * Moves the just-used kind to the front, leaving the relative order of the rest untouched.
 */
export function promoteTerminalKind(
    order: readonly TerminalKind[],
    kind: TerminalKind,
): TerminalKind[] {
    return orderTerminalKindsByRecency([kind, ...order]);
}

function readPersistedOrder(): TerminalKind[] {
    const parsed = readLocalStorageJson(STORAGE_KEY);
    return orderTerminalKindsByRecency(Array.isArray(parsed) ? parsed : []);
}

interface TerminalKindRecencyState {
    /**
     * Every Terminal kind, most recently chosen first.
     */
    order: TerminalKind[];
    recordTerminalKind(kind: TerminalKind): void;
}

/**
 * Which Terminal the user reaches for, most recent first, so the Session-creation menu can lead with it. This is a
 * device-local presentation preference rather than Session state, so it persists to `localStorage` and is never written
 * through to the Server — the same boundary `stores/chrome-layout.ts` sits on.
 */
export const useTerminalKindRecencyStore = create<TerminalKindRecencyState>((set, get) => ({
    order: readPersistedOrder(),
    recordTerminalKind: (kind) => {
        const previous = get().order;
        if (previous[0] === kind) return;
        const order = promoteTerminalKind(previous, kind);
        writeLocalStorageJson(STORAGE_KEY, order);
        set({ order });
    },
}));
