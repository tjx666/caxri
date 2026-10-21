import { useState } from 'react';

import { initialRevealedRuns, nextRevealedRuns, revealedRunRanges } from './revealed-runs';

/**
 * One Markdown text node of a reply still streaming in. Every run of characters the pacer adds in one render becomes
 * its own `.text-reveal` span, keyed by its start offset, so a run fades in once when it mounts and keeps its animation
 * as later runs join it: the reply's tail reads as a soft gradient, as in the Codex app.
 */
export function RevealingText({ revealSince, value }: { revealSince: number; value: string }) {
    const [runs, setRuns] = useState(() =>
        initialRevealedRuns(value, performance.now(), revealSince),
    );
    const current = nextRevealedRuns(runs, value);
    // Derived from the previous render, as React documents for state that follows a prop.
    if (current !== runs) setRuns(current);
    return (
        <>
            {value.slice(0, current.settledEnd)}
            {revealedRunRanges(current).map(([start, end]) => (
                <span className="text-reveal" key={start}>
                    {value.slice(start, end)}
                </span>
            ))}
        </>
    );
}
