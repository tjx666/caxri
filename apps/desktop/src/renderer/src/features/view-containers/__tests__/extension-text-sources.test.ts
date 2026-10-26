import { describe, expect, it } from 'vitest';

import { viewContainersExtensionText } from '../../../i18n/locales/en/view-containers-extension-text';
import { extensionTextKey } from '../extension-text';

/**
 * Raw text of the bundled extensions' production sources, read at build time so the Renderer imports no Node API.
 */
const extensionSources = import.meta.glob(
    ['../../../../../../../../extensions/{git,status}/src/*.ts'],
    { eager: true, query: '?raw', import: 'default' },
);

const sources = Object.values(extensionSources).join('\n');

/**
 * Sentences the extensions assemble from a conditional or a retry suffix, so the catalog value is never one quoted
 * literal. Each lists the fragments the extension sources must still contain.
 */
const COMPOSED: Readonly<Record<string, readonly string[]>> = {
    'viewContainers.extensionText.sourceControl.hideExcluded': [
        "'Hide' : 'Show'} excluded files (",
    ],
    'viewContainers.extensionText.sourceControl.pullRequestLoadFailed': [
        'Unable to load pull request changes.',
        ' Refresh to retry.',
    ],
    'viewContainers.extensionText.sourceControl.excludedHiddenOne': ['excluded file${', ' hidden.'],
    'viewContainers.extensionText.sourceControl.excludedHiddenOther': [
        'excluded file${',
        ' hidden.',
    ],
    'viewContainers.extensionText.sourceControl.unpushedLocalOne': [
        'local commit${',
        'not included in pull request #',
    ],
    'viewContainers.extensionText.sourceControl.unpushedLocalOther': [
        'local commit${',
        'not included in pull request #',
    ],
    'viewContainers.extensionText.sourceControl.uncommittedOne': [
        "uncommitted ${count === 1 ? 'change' : 'changes'} in",
    ],
    'viewContainers.extensionText.sourceControl.uncommittedOther': [
        "uncommitted ${count === 1 ? 'change' : 'changes'} in",
    ],
    'viewContainers.extensionText.sourceControl.filesChangedOne': ['file${', "'s'} changed"],
    'viewContainers.extensionText.sourceControl.filesChangedOther': ['file${', "'s'} changed"],
};

/**
 * The longest literal run of a catalog value, as it must appear verbatim in an extension source.
 */
function literalFragment(template: string): string {
    return template
        .split(/\{\{\w+\}\}/)
        .map((part) => part.trim())
        .toSorted((left, right) => right.length - left.length)[0];
}

describe('extension text catalog against extension sources', () => {
    it('keeps every catalog sentence in sync with what extensions/git and extensions/status emit', () => {
        const stale = Object.entries(viewContainersExtensionText)
            .filter(([key, template]) => {
                const fragments = COMPOSED[key] ?? [literalFragment(template)];
                return fragments.some(
                    (fragment) => fragment.length > 0 && !sources.includes(fragment),
                );
            })
            .map(([key]) => key);
        // A reworded extension sentence leaves its catalog entry here: update both sides together.
        expect(stale).toEqual([]);
    });

    it('resolves the first-run empty states and headers the extensions emit', () => {
        for (const sentence of [
            'Working tree clean.',
            'No commits yet.',
            'Source Control',
            'Working Tree Changes',
            'Changes',
            'Commits',
            'No origin',
            'Sync Changes in caxri',
        ]) {
            expect(sources, sentence).toContain(sentence.replace('caxri', ''));
            expect(extensionTextKey(sentence), sentence).toBeDefined();
        }
    });
});
