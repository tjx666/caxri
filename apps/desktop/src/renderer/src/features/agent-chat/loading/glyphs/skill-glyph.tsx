import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { pivotAt, sparklePath, staggerIndex } from '../glyph-geometry';

const DUST = [
    [19.6, 12.4, 1.3],
    [17.6, 16.2, 1],
    [21.2, 17.4, 0.9],
    [20.6, 4.6, 1.1],
] as const;

/**
 * Loading a skill: a magic wand flicks and sprinkles stardust that twinkles as it drifts down.
 */
export function SkillGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <g className="skill-wand" style={pivotAt(5, 20)}>
                <path
                    d="M5 20 13.6 11.4"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="2.2"
                />
                <path className="skill-star" d={sparklePath(15.4, 9.6, 3.6, 0.24)} />
            </g>
            {DUST.map(([cx, cy, radius], index) => (
                <path
                    className="skill-dust"
                    d={sparklePath(cx, cy, radius, 0.25)}
                    key={cx}
                    style={staggerIndex(index)}
                />
            ))}
        </GlyphFrame>
    );
}
