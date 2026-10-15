import {
    agentToolLabel,
    describeAgentTool,
    gitDiffTabLabel,
    parseGitDiffTab,
    trackerExcerptText,
    trackerReferenceText,
} from '@caxri/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    trackerExcerptText as desktopTrackerExcerpt,
    trackerReferenceText as desktopTrackerReference,
} from '../../features/agent-chat/agent-chat-tracker-labels';
import { documentTabPresentation } from '../../features/editor/document-tab-presentation';
import { translate, useLocaleStore } from '..';
import { DIFF_TAB_PATHS, TOOL_CALLS, TRACKERS } from './english-counterpart-parity.fixture';

/**
 * Registry of every Desktop English counterpart of an English presentation helper in `@caxri/protocol`.
 *
 * Most Agent Chat copy has no counterpart: Desktop and the phone call the same protocol helper with their own `t` over
 * the shared Agent Chat label catalog. The helpers below still have a Desktop-only localized copy. Under the English
 * locale the two must agree byte for byte, so a wording or rule change on one side fails here instead of making Desktop
 * silently disagree with the phone. Each row feeds both sides the same inputs, chosen to reach every branch.
 *
 * A new localized counterpart registers a row here (docs/i18n.md).
 */

interface ParityRow {
    name: string;
    /**
     * Desktop's English output and the protocol output for the same inputs, in the same order.
     */
    run: () => { desktop: unknown[]; protocol: unknown[] };
}

/**
 * Runs both sides over the same inputs. Each side is called with the input alone, so a Desktop helper's optional `t`
 * parameter never receives the array index and the default English `translate` applies.
 */
function pair<T>(
    inputs: readonly T[],
    desktop: (input: T) => unknown,
    protocol: (input: T) => unknown,
): { desktop: unknown[]; protocol: unknown[] } {
    return {
        desktop: inputs.map((input) => desktop(input)),
        protocol: inputs.map((input) => protocol(input)),
    };
}

const ROWS: ParityRow[] = [
    {
        name: 'trackerReferenceText and trackerExcerptText',
        run: () =>
            pair(
                TRACKERS,
                (artifact) => [
                    desktopTrackerReference(artifact, translate),
                    desktopTrackerExcerpt(artifact, translate),
                ],
                (artifact) => [trackerReferenceText(artifact), trackerExcerptText(artifact)],
            ),
    },
    {
        name: 'gitDiffTabLabel',
        run: () =>
            pair(
                DIFF_TAB_PATHS,
                (path) => documentTabPresentation(path, {}).label,
                (path) => {
                    const tab = parseGitDiffTab(path);
                    return tab && gitDiffTabLabel(tab);
                },
            ),
    },
];

describe('Desktop English counterparts of protocol presentation helpers', () => {
    beforeEach(() => useLocaleStore.setState({ locale: 'en' }));

    it.each(ROWS)('$name matches the protocol English byte for byte', ({ run }) => {
        const { desktop, protocol } = run();
        expect(desktop.length).toBeGreaterThan(0);
        expect(desktop).toEqual(protocol);
    });

    it('translates every action label the protocol tool table produces', () => {
        const labels = TOOL_CALLS.map((tool) => describeAgentTool(tool))
            .filter(({ kind }) => !['browser', 'computer', 'mcp', 'other'].includes(kind))
            .map(({ label }) => label);
        useLocaleStore.setState({ locale: 'zh-CN' });
        const untranslated = labels.filter((label) => agentToolLabel(label, translate) === label);
        expect(untranslated).toEqual([]);
    });
});
