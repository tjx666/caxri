/**
 * Three muted dots that breathe one after another, as the Claude and ChatGPT apps hold a reply's place.
 */
export function DotsFigure() {
    return (
        <span className="agent-chat-figure flex items-center gap-1">
            {[0, 1, 2].map((index) => (
                <span className="figure-dot size-1.5 rounded-full bg-current" key={index} />
            ))}
        </span>
    );
}
