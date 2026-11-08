import { createSharedLocalState } from '../../lib/local-storage';
import { createStore } from '../../lib/store';
import type { BenchmarkDraft } from './benchmark-selection';
import { draftFromPreferences, draftPreferencesOf } from './benchmark-selection';

const DRAFT_PREFERENCES_STORAGE_KEY = 'caxri.benchmark.draftPreferences';

/**
 * Shared by every window of the profile (docs/client-local-data.md) but never subscribed: the entry is one value
 * written when a run starts, and applying another window's write live would overwrite the half-written draft this
 * window is editing. The next page that opens seeds from it.
 */
const sharedPreferences = createSharedLocalState(
    DRAFT_PREFERENCES_STORAGE_KEY,
    draftFromPreferences,
);

/**
 * Which board the page shows: the New run form or one run.
 */
type BenchmarkSelection = { kind: 'new' } | { kind: 'run'; runId: string };

interface BenchmarkPageState {
    selection: BenchmarkSelection;
    /**
     * The New run form's contents. Kept here rather than in the page, so switching to another tab and back, or to a
     * past run and back, does not lose a half-written prompt.
     */
    draft: BenchmarkDraft;
    setSelection: (selection: BenchmarkSelection) => void;
    /**
     * Accepts an updater so consecutive edits within one frame (quick chip toggles) each build on the latest draft
     * instead of the one their render captured.
     */
    setDraft: (draft: BenchmarkDraft | ((current: BenchmarkDraft) => BenchmarkDraft)) => void;
}

export const useBenchmarkPageStore = createStore<BenchmarkPageState>('benchmarkPage', (set) => ({
    selection: { kind: 'new' },
    draft: sharedPreferences.read(),
    setSelection: (selection) => set({ selection }),
    setDraft: (draft) =>
        set((state) => ({ draft: typeof draft === 'function' ? draft(state.draft) : draft })),
}));

/**
 * Remembers a started draft's choices for the next run. Storage is device-local chrome preference, like panel sizes, so
 * a window with storage disabled simply starts from defaults next time.
 */
export function rememberDraftPreferences(draft: BenchmarkDraft): void {
    sharedPreferences.write(draftPreferencesOf(draft));
}
