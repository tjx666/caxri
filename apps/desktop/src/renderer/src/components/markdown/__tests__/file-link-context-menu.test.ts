import { describe, expect, it, vi } from 'vitest';

import type { ContextMenuEntries, ContextMenuEntry } from '../../../lib/context-menu';
import { fileLinkContextMenu } from '../file-link-context-menu';

type MenuItem = Extract<ContextMenuEntry, { onSelect: () => unknown }>;

function items(entries: ContextMenuEntries): MenuItem[] {
    return entries.filter(
        (entry): entry is MenuItem => Boolean(entry) && 'onSelect' in (entry as object),
    );
}

describe('fileLinkContextMenu', () => {
    it('offers Open File, Reveal in Finder, and Copy Path, each running its own action', () => {
        const actions = { onCopy: vi.fn(), onOpen: vi.fn(), onReveal: vi.fn() };
        const entries = fileLinkContextMenu(actions);

        expect(items(entries).map((entry) => entry.label)).toEqual([
            'Open File',
            'Reveal in Finder',
            'Copy Path',
        ]);
        for (const entry of items(entries)) entry.onSelect();
        expect(actions.onOpen).toHaveBeenCalledTimes(1);
        expect(actions.onReveal).toHaveBeenCalledTimes(1);
        expect(actions.onCopy).toHaveBeenCalledTimes(1);
    });

    it('leaves Reveal in Finder out where the host cannot show the file on this Mac', () => {
        const entries = fileLinkContextMenu({ onCopy: vi.fn(), onOpen: vi.fn() });

        expect(items(entries).map((entry) => entry.label)).toEqual(['Open File', 'Copy Path']);
    });
});
