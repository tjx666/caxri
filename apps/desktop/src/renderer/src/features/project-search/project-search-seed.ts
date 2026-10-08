import { focusedTextSelection } from '../../lib/focused-text-selection';
import { useDialogStore } from '../../stores/dialogs';

/**
 * Longer text is almost certainly a paste of something other than a search term, and would only push the user's
 * previous query out of the input for nothing.
 */
const MAX_SEED_QUERY_LENGTH = 200;

/**
 * The query a piece of selected or copied text stands for, or `undefined` when it does not look like one. Multi-line
 * text is refused rather than cut to its first line: the dialog's input is single-line, and a block of code is a copy
 * the user made for some other purpose.
 */
export function projectSearchSeedQuery(text: string): string | undefined {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_SEED_QUERY_LENGTH || /[\r\n]/u.test(trimmed)) return;
    return trimmed;
}

/**
 * Seeds `cmd+shift+f` the way VS Code seeds its search from the editor selection, with the clipboard as a fallback so a
 * term copied elsewhere (a browser, a log) is one keystroke away. The selection is read before the first `await`, while
 * focus is still on the surface the user invoked the shortcut from.
 */
export async function resolveProjectSearchSeedQuery(
    readClipboard: () => Promise<string> = () => navigator.clipboard.readText(),
): Promise<string | undefined> {
    const selected = projectSearchSeedQuery(focusedTextSelection());
    if (selected) return selected;
    try {
        return projectSearchSeedQuery(await readClipboard());
    } catch {
        /*
        A denied or empty clipboard only means there is nothing to seed.
        */
        return undefined;
    }
}

export async function openSeededProjectSearch(): Promise<void> {
    const query = await resolveProjectSearchSeedQuery();
    useDialogStore.getState().openProjectSearch(query === undefined ? {} : { query });
}

/**
 * The `Files to include` pattern that scopes a search to one Project directory. The trailing `/**` is required: the
 * search matches a pattern containing `/` against the whole relative path, so the bare directory path would only ever
 * match the directory itself. The Project root itself needs no pattern at all.
 */
export function projectSearchFolderInclude(relativeDirectory: string): string {
    return relativeDirectory === '.' ? '' : `${relativeDirectory}/**`;
}
