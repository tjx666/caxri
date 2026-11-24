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

    it('offers Open in Browser right after Open File when the link names an HTML page', () => {
        const onOpenInBrowser = vi.fn();
        const entries = fileLinkContextMenu({
            onCopy: vi.fn(),
            onOpen: vi.fn(),
            onOpenInBrowser,
            onReveal: vi.fn(),
        });

        expect(items(entries).map((entry) => entry.label)).toEqual([
            'Open File',
            'Open in Browser',
            'Reveal in Finder',
            'Copy Path',
        ]);
        items(entries)[1]?.onSelect();
        expect(onOpenInBrowser).toHaveBeenCalledTimes(1);
    });
});
