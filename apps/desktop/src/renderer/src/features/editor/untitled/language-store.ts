import { createStore } from '../../../lib/store';

interface UntitledLanguageState {
    /**
     * Detected language candidates per untitled buffer, keyed by `untitledLanguageKey`, best first. Each is a file
     * extension (`py`, `ts`); the editor uses the first one Monaco has a language for. A buffer without an entry is
     * Plain Text.
     */
    candidates: Record<string, readonly string[]>;
    setCandidates(key: string, candidates: readonly string[]): void;
    clear(key: string): void;
}

/**
 * Identifies one untitled buffer across Sessions: the session-view scope and the tab path.
 */
export function untitledLanguageKey(scope: string, path: string): string {
    return `${scope}\u{0}${path}`;
}

/**
 * What language detection decided for each untitled buffer. Renderer-only, like the buffer: a restored buffer is
 * detected again from its content.
 */
export const useUntitledLanguageStore = createStore<UntitledLanguageState>(
    'untitledLanguages',
    (set) => ({
        candidates: {},
        setCandidates(key, candidates) {
            set((state) => {
                const current = state.candidates[key] as readonly string[] | undefined;
                if (
                    current?.length === candidates.length &&
                    current.every((value, index) => value === candidates[index])
                )
                    return state;
                return { candidates: { ...state.candidates, [key]: candidates } };
            });
        },
        clear(key) {
            set((state) => {
                if (!Object.hasOwn(state.candidates, key)) return state;
                return {
                    candidates: Object.fromEntries(
                        Object.entries(state.candidates).filter(([candidate]) => candidate !== key),
                    ),
                };
            });
        },
    }),
);
