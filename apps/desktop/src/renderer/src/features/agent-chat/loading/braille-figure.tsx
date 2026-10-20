import { staggerIndex } from './glyph-geometry';

/**
 * The 2x4 Braille cell in the order a terminal spinner (`⠋⠙⠹`) walks it: down the left column, up the right.
 */
const CELL_ORDER = [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 3],
    [1, 2],
    [1, 1],
    [1, 0],
] as const;

/**
 * A snake with a fading tail circling a Braille cell, the terminal's own spinner language.
 */
export function BrailleFigure() {
    return (
        <svg className="agent-chat-figure" height="20" viewBox="0 0 10 17" width="12">
            {CELL_ORDER.map(([column, row], index) => (
                <circle
                    className="figure-braille-dot"
                    cx={2.5 + column * 5}
                    cy={2 + row * 4.3}
                    fill="currentColor"
                    key={`${column}-${row}`}
                    r="1.35"
                    style={staggerIndex(index)}
                />
            ))}
        </svg>
    );
}
