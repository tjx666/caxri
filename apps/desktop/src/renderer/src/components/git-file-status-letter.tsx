import type { GitDecoration } from '../lib/git-decorations';
import { gitDecorationClassName } from '../lib/git-decorations';
import { cn } from '../lib/utilities';

/**
 * Single-letter Git status badge (M/A/D/U/C…) colored by change kind, shared by Source Control, diff headers, the file
 * tree, and the tab strip. The color comes from the theme's `gitDecoration.*` roles rather than the generic status
 * palette, so a file reads the same here as it would in VS Code under the same theme.
 *
 * Renders nothing without a letter: a directory carries only the color of the strongest change beneath it, matching VS
 * Code, which reserves the letter for the file that actually changed.
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
