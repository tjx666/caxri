import { describe, expect, it } from 'vitest';

import {
    FILE_TREE_ROW_HEIGHT,
    fileTreeLeafIndent,
    fileTreeRowStyle,
    MAX_STICKY_ANCESTORS,
} from '../file-tree-row-style';

describe('fileTreeRowStyle', () => {
    it('indents a directory to its chevron and a leaf to the icon column', () => {
        expect(fileTreeRowStyle({ depth: 0, isDirectory: true, isExpanded: false })).toMatchObject({
            paddingLeft: 8,
        });
        expect(fileTreeRowStyle({ depth: 2, isDirectory: true, isExpanded: false })).toMatchObject({
            paddingLeft: 32,
        });
        expect(fileTreeRowStyle({ depth: 2, isDirectory: false, isExpanded: false })).toMatchObject(
            {
                paddingLeft: fileTreeLeafIndent(2),
            },
        );
    });

    it('pins an expanded directory below the ancestors already pinned above it', () => {
        expect(fileTreeRowStyle({ depth: 0, isDirectory: true, isExpanded: true })).toMatchObject({
            position: 'sticky',
            top: 0,
            zIndex: 1,
        });
        expect(fileTreeRowStyle({ depth: 3, isDirectory: true, isExpanded: true })).toMatchObject({
            position: 'sticky',
            top: 3 * FILE_TREE_ROW_HEIGHT,
            zIndex: 4,
        });
    });

    it('leaves a collapsed directory and a file in the scroll flow', () => {
        expect(
            fileTreeRowStyle({ depth: 1, isDirectory: true, isExpanded: false }).position,
        ).toBeUndefined();
        expect(
            fileTreeRowStyle({ depth: 1, isDirectory: false, isExpanded: true }).position,
        ).toBeUndefined();
    });

    it('caps the pinned stack so a deep tree cannot fill the panel', () => {
        const deep = fileTreeRowStyle({ depth: 40, isDirectory: true, isExpanded: true });

        expect(deep.top).toBe((MAX_STICKY_ANCESTORS - 1) * FILE_TREE_ROW_HEIGHT);
        expect(deep.zIndex).toBe(1 + MAX_STICKY_ANCESTORS);
    });

    it('reserves the pinned height so keyboard navigation never scrolls a row under it', () => {
        expect(fileTreeRowStyle({ depth: 0, isDirectory: false, isExpanded: false })).toMatchObject(
            {
                scrollMarginTop: 0,
            },
        );
        expect(fileTreeRowStyle({ depth: 2, isDirectory: false, isExpanded: false })).toMatchObject(
            {
                scrollMarginTop: 2 * FILE_TREE_ROW_HEIGHT,
            },
        );
        expect(
            fileTreeRowStyle({ depth: 40, isDirectory: false, isExpanded: false }),
        ).toMatchObject({ scrollMarginTop: MAX_STICKY_ANCESTORS * FILE_TREE_ROW_HEIGHT });
    });
});
