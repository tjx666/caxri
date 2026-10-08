import type { SourceControlResource } from '@caxri/protocol';

import { asGitDecorationKind, gitDecorationClassName } from '../../../lib/git-decorations';

type SourceControlResourceDecoration = NonNullable<SourceControlResource['decoration']>;

/**
 * The `--git-*` role one Source Control decoration paints, as a Tailwind text color.
 *
 * A changed file has to read the same wherever its name appears (DESIGN.md, "Git decorations"), so this resolves the
 * decoration's `identifier` (the Git change kind, for Caxri's Git extension) through the same table the Files tree, the
 * tab strip, and the diff headers use. Reading the generic `tone` instead is what used to break that promise: three
 * tones cannot hold five roles, so `added` and `untracked` both came out green and a `modified` file wore the same
 * amber as a warning chip.
 *
 * `tone` survives only as the fallback for a Source Control provider that is not Git and whose identifier therefore
 * names no Git change kind. The Extension API is provider-agnostic (`view-providers.ts`,
 * `SourceControlResourceDecoration`), so the generic tone stays the one color contract such a provider can rely on; the
 * `--git-*` roles are claimed by identifier, not by making every provider speak Git.
 */
export function sourceControlDecorationClassName(
    decoration: SourceControlResourceDecoration,
): string {
    const kind = asGitDecorationKind(decoration.identifier);
    if (kind) return gitDecorationClassName(kind);
    switch (decoration.tone) {
        case 'success':
            return 'text-success';
        case 'warning':
            return 'text-warning';
        default:
            return 'text-danger';
    }
}
