import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/caxri', () => ({ caxri: { request: vi.fn() } }));

import { translate } from '../../../i18n';
import { serializeContextMenu } from '../../../lib/context-menu';
import { useEnvironmentStore } from '../../../stores/environment';
import { documentTabPathMenu } from '../document-tab-path-menu';

const clipboard = vi.hoisted(() => ({
    writeText: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock('../../../lib/clipboard', () => ({
    textClipboard: { writeText: (text: string) => clipboard.writeText(text) },
    writeClipboardText: (text: string) => clipboard.writeText(text),
}));

function item(entries: ReturnType<typeof documentTabPathMenu>, label: string) {
    const { actions, items } = serializeContextMenu(entries);
    const match = items.find(
        (candidate) => candidate.type !== 'separator' && candidate.label === label,
    );
    return match && match.type !== 'separator'
        ? { enabled: match.enabled !== false, run: actions.get(match.id!) }
        : undefined;
}

describe('documentTabPathMenu', () => {
    beforeEach(() => {
        useEnvironmentStore.setState({ state: { kind: 'local' } });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('copies the file name of a Project file and of an external document', async () => {
        const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
        clipboard.writeText = writeText;

        await item(
            documentTabPathMenu(
                {
                    resolution: { absolutePath: '/project/src/notes.ts', relativeRoot: '/project' },
                    unavailableReason: 'unavailable',
                },
                translate,
            ),
            'Copy Name',
        )?.run?.();
        expect(writeText).toHaveBeenLastCalledWith('notes.ts');

        await item(
            documentTabPathMenu(
                {
                    resolution: { absolutePath: '/outside/guide.md' },
                    unavailableReason: 'unavailable',
                    externalDocumentId: 'external-1',
                },
                translate,
            ),
            'Copy Name',
        )?.run?.();
        expect(writeText).toHaveBeenLastCalledWith('guide.md');
    });

    it('disables Copy Name while the path is unresolved', () => {
        expect(
            item(documentTabPathMenu({ unavailableReason: 'unavailable' }, translate), 'Copy Name')
                ?.enabled,
        ).toBe(false);
    });
});
