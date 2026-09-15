import { describe, expect, it } from 'vitest';

import { gitDecorationClassName } from '../../../../lib/git-decorations';
import { sourceControlDecorationClassName } from '../source-control-decorations';

describe('Source Control decoration colors', () => {
    it('gives every Git change kind its own --git-* role', () => {
        expect(
            [
                sourceControlDecorationClassName({
                    identifier: 'added',
                    label: 'A',
                    tone: 'success',
                }),
                sourceControlDecorationClassName({
                    identifier: 'modified',
                    label: 'M',
                    tone: 'warning',
                }),
                sourceControlDecorationClassName({
                    identifier: 'deleted',
                    label: 'D',
                    tone: 'danger',
                }),
                sourceControlDecorationClassName({
                    identifier: 'untracked',
                    label: 'U',
                    tone: 'success',
                }),
                sourceControlDecorationClassName({
                    identifier: 'conflicted',
                    label: 'C',
                    tone: 'danger',
                }),
            ],
            // Five kinds, five distinct roles: the three-value `tone` collapsed added onto untracked and painted a
            // modified file the same amber as a warning chip.
        ).toEqual([
            'text-git-added',
            'text-git-modified',
            'text-git-deleted',
            'text-git-untracked',
            'text-git-conflicting',
        ]);
    });

    it('paints the same role the Files tree paints for that change', () => {
        expect(
            sourceControlDecorationClassName({
                identifier: 'modified',
                label: 'M',
                tone: 'warning',
            }),
        ).toBe(gitDecorationClassName('modified'));
    });

    it('shares the untracked role with renamed, as the two VS Code defaults do', () => {
        expect(
            sourceControlDecorationClassName({
                identifier: 'renamed',
                label: 'R',
                tone: 'warning',
            }),
        ).toBe('text-git-untracked');
    });

    it('falls back to the generic tone for a provider that is not Git', () => {
        expect(
            sourceControlDecorationClassName({ identifier: 'staged', label: 'S', tone: 'success' }),
        ).toBe('text-success');
        expect(
            sourceControlDecorationClassName({ identifier: 'review', label: 'R', tone: 'warning' }),
        ).toBe('text-warning');
        // `[a-z0-9-]+` admits an `Object.prototype` key; it must not resolve to a Git role.
        expect(
            sourceControlDecorationClassName({
                identifier: 'constructor',
                label: '?',
                tone: 'danger',
            }),
        ).toBe('text-danger');
    });
});
