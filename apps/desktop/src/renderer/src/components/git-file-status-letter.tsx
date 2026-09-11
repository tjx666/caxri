import type { GitDecoration } from '../lib/git-decorations';
import { gitDecorationClassName } from '../lib/git-decorations';
import { cn } from '../lib/utilities';

/**
 * Single-letter Git status badge (M/A/D/?/U…) colored by change kind, shared by diff headers, the file tree, and the
 * tab strip. The color comes from the theme's `gitDecoration.*` roles rather than the generic status palette, so a file
 * reads the same here as it would in VS Code under the same theme. Source Control paints its own letter from the
 * Extension API's `tone`, which still resolves to the generic palette.
 *
 * Renders nothing without a letter: a directory carries only the color of the strongest change beneath it, matching VS
 * Code, which reserves the letter for the file that actually changed.
 *
 * Hidden from assistive technology on purpose. A tree row and a tab are named by the file they hold, and folding the
 * letter into that name would rename `tracked.ts` to `tracked.ts M` for every screen reader and every role query. Each
 * surface states the change in its own accessible text instead: Source Control in its explicit `aria-label`, the tree
 * and tab strip in the `sr-only` description `gitDecorationDescription` produces.
 */
export function GitFileStatusLetter({
    className,
    decoration,
}: {
    className?: string;
    decoration: GitDecoration;
}) {
    if (!decoration.letter) return null;
    return (
        <span
            aria-hidden="true"
            className={cn(
                `status status-${decoration.kind}`,
                'min-w-4 flex-none text-center font-mono font-bold',
                gitDecorationClassName(decoration.kind),
                className,
            )}
        >
            {decoration.letter}
        </span>
    );
}
