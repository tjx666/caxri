import type { SessionMenuItemId } from '@caxri/protocol';
import { defaultSessionMenuLayout, sessionMenuItemIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { serializeContextMenu } from '../../../lib/context-menu';
import type { SessionMenuSlots } from '../session-menu-arrangement';
import { arrangeSessionMenu } from '../session-menu-arrangement';

function slotsLabeledById(absent: SessionMenuItemId[] = []): SessionMenuSlots {
    return Object.fromEntries(
        sessionMenuItemIds.map((id) => [
            id,
            !absent.includes(id) && { label: id, onSelect: () => {} },
        ]),
    ) as SessionMenuSlots;
}

function labels(entries: ReturnType<typeof arrangeSessionMenu>): string[] {
    return serializeContextMenu(entries).items.map((item) =>
        item.type === 'separator' ? '---' : (item.label ?? ''),
    );
}

describe('arrangeSessionMenu', () => {
    it('puts the actions that close out a Session first and Delete alone at the end', () => {
        const rendered = labels(arrangeSessionMenu(slotsLabeledById(), defaultSessionMenuLayout));
        expect(rendered.slice(0, 4)).toEqual(['markAsDone', 'archive', 'pin', '---']);
        expect(rendered.slice(-2)).toEqual(['---', 'deleteSession']);
    });

    it('follows a customized order and skips hidden items', () => {
        const rendered = labels(
            arrangeSessionMenu(slotsLabeledById(), {
                order: ['rename', 'separator', 'archive', 'handOverToBot'],
                hidden: ['handOverToBot'],
            }),
        );
        expect(rendered).toEqual(['rename', '---', 'archive']);
    });

    it('drops the separator a group of inapplicable or hidden slots leaves behind', () => {
        const rendered = labels(
            arrangeSessionMenu(slotsLabeledById(['markAsDone']), {
                order: ['markAsDone', 'separator', 'archive', 'separator', 'pin'],
                hidden: ['pin'],
            }),
        );
        expect(rendered).toEqual(['archive']);
    });
});
