import { describe, expect, it, vi } from 'vitest';

import { linkContextMenu } from '../markdown/link-context-menu';

describe('linkContextMenu', () => {
    it('offers Open Link and Copy Link, each running its own action', () => {
        const onCopy = vi.fn();
        const onOpen = vi.fn();
        const entries = linkContextMenu({ onCopy, onOpen });
        const items = entries.flatMap((entry) =>
            entry && entry.type !== 'separator' && entry.type !== 'submenu' ? [entry] : [],
        );
        expect(items.map((item) => item.label)).toEqual(['Open Link', 'Copy Link']);
        items[0]?.onSelect();
        expect(onOpen).toHaveBeenCalledOnce();
        expect(onCopy).not.toHaveBeenCalled();
        items[1]?.onSelect();
        expect(onCopy).toHaveBeenCalledOnce();
    });
});
