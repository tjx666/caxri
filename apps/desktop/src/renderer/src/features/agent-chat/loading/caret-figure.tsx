/**
 * A `C` that draws itself and wipes away around a blinking caret, where the reply's first character will appear.
 */
export function CaretFigure() {
    return (
        <svg
            className="agent-chat-figure overflow-visible"
            fill="none"
            height="20"
            stroke="currentColor"
            strokeLinecap="round"
            viewBox="0 0 24 24"
            width="20"
        >
            <path className="figure-arc" d="M16.36 7.5A7 7 0 1 0 16.36 16.5" strokeWidth="2.4" />
            <path
                className="figure-caret"
                d="M16.4 10.4v3.2"
                stroke="var(--merged)"
                strokeWidth="2.4"
            />
        </svg>
    );
}
