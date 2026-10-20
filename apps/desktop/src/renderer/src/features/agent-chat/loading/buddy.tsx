import './loading.css';

import { GLYPH_CUTOUT, staggerIndex } from './glyph-geometry';
import type { BuddyMood } from './presentation';

const SWEAT_DROP = 'M19.6 5.2c.9 1.2 1.3 2 1.3 2.6a1.3 1.3 0 0 1-2.6 0c0-.6.4-1.4 1.3-2.6z';

interface EyeShape {
    cy: number;
    rx: number;
    ry: number;
}

/**
 * Eye shapes for the moods that look around: reading squints, searching widens the eye behind the lens.
 */
const LOOKING_EYES: Record<
    Exclude<BuddyMood, 'compact' | 'wait' | 'tired' | 'run'>,
    [EyeShape, EyeShape]
> = {
    think: [
        { cy: 12.6, rx: 1.6, ry: 2.2 },
        { cy: 12.6, rx: 1.6, ry: 2.2 },
    ],
    read: [
        { cy: 13, rx: 1.7, ry: 1.25 },
        { cy: 13, rx: 1.7, ry: 1.25 },
    ],
    search: [
        { cy: 12.6, rx: 1.6, ry: 2.2 },
        { cy: 12.6, rx: 2, ry: 2.6 },
    ],
};

/**
 * Buddy's eyes and mouth for a mood. Moods that look around (`think`, `read`, `search`) move their eyes as one group.
 */
function BuddyFace({ mood }: { mood: BuddyMood }) {
    switch (mood) {
        case 'compact': {
            return (
                <g
                    fill="none"
                    stroke={GLYPH_CUTOUT}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                >
                    <path d="m6.6 11.6 2 1.4-2 1.4" />
                    <path d="m15.4 11.6-2 1.4 2 1.4" />
                </g>
            );
        }
        case 'wait': {
            return (
                <g fill="none" stroke={GLYPH_CUTOUT} strokeLinecap="round" strokeWidth="1.5">
                    <path d="M6.6 13.2q1.4 1.2 2.8 0" />
                    <path d="M12.6 13.2q1.4 1.2 2.8 0" />
                </g>
            );
        }
        case 'tired': {
            return (
                <>
                    <g fill="none" stroke={GLYPH_CUTOUT} strokeLinecap="round" strokeWidth="1.5">
                        <path d="M6.6 12.4h2.8" />
                        <path d="M12.6 12.4h2.8" />
                    </g>
                    <ellipse
                        className="buddy-yawn"
                        cx="11"
                        cy="16"
                        fill={GLYPH_CUTOUT}
                        rx="1.4"
                        ry="1.8"
                    />
                </>
            );
        }
        case 'run': {
            return (
                <>
                    <ellipse cx="8" cy="13" fill={GLYPH_CUTOUT} rx="1.6" ry="1.9" />
                    <ellipse cx="14" cy="13" fill={GLYPH_CUTOUT} rx="1.6" ry="1.9" />
                    <g fill="none" stroke={GLYPH_CUTOUT} strokeLinecap="round" strokeWidth="1.3">
                        <path d="M6.2 9.9 9.6 10.9" />
                        <path d="M15.8 9.9 12.4 10.9" />
                    </g>
                </>
            );
        }
        default: {
            const [left, right] = LOOKING_EYES[mood];
            return (
                <g className="buddy-look">
                    <g className="buddy-blink">
                        <ellipse cx="8" fill={GLYPH_CUTOUT} {...left} />
                        <ellipse cx="14" fill={GLYPH_CUTOUT} {...right} />
                    </g>
                    {mood === 'search' && (
                        <g
                            fill="none"
                            stroke="var(--merged)"
                            strokeLinecap="round"
                            strokeWidth="1.3"
                        >
                            <circle cx="14" cy="12.6" r="3.6" />
                            <path d="m16.6 15.2 2.4 2.4" />
                        </g>
                    )}
                </g>
            );
        }
    }
}

/**
 * The rare party hat (`isBuddyPartyTurn`), drawn above the head past the SVG's box.
 */
function PartyHat() {
    return (
        <g className="buddy-hat">
            <path d="M6.4 6.6 11.4-3.4 15.8 6.6Z" fill="var(--merged)" />
            <path
                d="M8.2 3.4 14.2 2.6M9.8.2l3.2-.5"
                stroke="var(--accent)"
                strokeLinecap="round"
                strokeWidth="1.1"
            />
            <circle cx="11.4" cy="-3.6" fill="var(--warning)" r="1.5" />
        </g>
    );
}

/**
 * Buddy: a small round character that acts out what the Agent is doing (see `BuddyMood`). Pointing at it boops it: it
 * squishes, its eyes turn into happy arcs, and a heart floats up. It is decoration, so assistive technology never sees
 * it; the status line names the activity.
 */
export function Buddy({
    isParty = false,
    mood,
    size = 20,
}: {
    isParty?: boolean;
    mood: BuddyMood;
    size?: number;
}) {
    return (
        <span
            aria-hidden="true"
            className="agent-chat-buddy relative inline-flex shrink-0"
            data-mood={mood}
            style={{ width: size, height: size }}
        >
            <svg
                className="buddy-idle overflow-visible"
                height={size}
                viewBox="0 0 24 24"
                width={size}
            >
                <g className="buddy-body">
                    <circle cx="11" cy="13" fill="var(--foreground)" r="8" />
                    <BuddyFace mood={mood} />
                </g>
                {mood === 'think' &&
                    [
                        [18.6, 5.6, 1],
                        [21.2, 2.6, 1.5],
                    ].map(([cx, cy, radius], index) => (
                        <circle
                            className="buddy-bubble"
                            cx={cx}
                            cy={cy}
                            fill="var(--foreground)"
                            key={cx}
                            r={radius}
                            style={staggerIndex(index)}
                        />
                    ))}
                {(mood === 'run' || mood === 'tired') && (
                    <path className="buddy-sweat" d={SWEAT_DROP} fill="var(--git-modified)" />
                )}
                {mood === 'wait' &&
                    [0, 1].map((index) => (
                        <path
                            className="buddy-z"
                            d="M18 4h2.6L18 7h2.6"
                            fill="none"
                            key={index}
                            stroke="var(--muted)"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="1.1"
                            style={staggerIndex(index)}
                        />
                    ))}
                {isParty && <PartyHat />}
            </svg>
            <svg
                className="buddy-booped absolute inset-0 overflow-visible"
                height={size}
                viewBox="0 0 24 24"
                width={size}
            >
                <g className="buddy-squish">
                    <circle cx="11" cy="13" fill="var(--foreground)" r="8" />
                    <g fill="none" stroke={GLYPH_CUTOUT} strokeLinecap="round" strokeWidth="1.5">
                        <path d="M6.6 13q1.4-1.6 2.8 0" />
                        <path d="M12.6 13q1.4-1.6 2.8 0" />
                    </g>
                    <circle cx="6" cy="15.6" fill="var(--accent)" opacity=".6" r="1.3" />
                    <circle cx="16" cy="15.6" fill="var(--accent)" opacity=".6" r="1.3" />
                </g>
                <path
                    className="buddy-heart"
                    d="M20 6.2c-1-.9-2.2-1.4-2.2-2.5a1.1 1.1 0 0 1 2.2-.2 1.1 1.1 0 0 1 2.2.2c0 1.1-1.2 1.6-2.2 2.5z"
                    fill="var(--accent)"
                />
                {isParty && <PartyHat />}
            </svg>
        </span>
    );
}
