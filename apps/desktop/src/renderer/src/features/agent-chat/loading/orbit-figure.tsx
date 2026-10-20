/**
 * Two stars circling each other in perspective, growing as they swing near and shrinking as they swing away.
 */
export function OrbitFigure() {
    return (
        <svg
            className="agent-chat-figure overflow-visible"
            height="20"
            viewBox="0 0 24 24"
            width="20"
        >
            <ellipse
                cx="12"
                cy="12"
                fill="none"
                opacity=".18"
                rx="8"
                ry="2.6"
                stroke="currentColor"
            />
            {(['var(--merged)', 'var(--accent)'] as const).map((color, index) => (
                <g className={index === 0 ? undefined : 'figure-orbit-late'} key={color}>
                    <g className="figure-orbit-x">
                        <circle className="figure-orbit-z" cx="12" cy="12" fill={color} r="3" />
                    </g>
                </g>
            ))}
        </svg>
    );
}
