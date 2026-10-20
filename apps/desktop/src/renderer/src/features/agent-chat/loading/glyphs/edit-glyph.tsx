import { useId } from 'react';

import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { cursivePath, pivotAt, svgId } from '../glyph-geometry';

/**
 * Editing: a pen writes an endless line of cursive that flows away to the left and fades out, its nib bobbing with each
 * loop.
 */
export function EditGlyph({ size }: GlyphProperties) {
    const id = svgId(useId());
    return (
        <GlyphFrame size={size}>
            <defs>
                <linearGradient
                    gradientUnits="userSpaceOnUse"
                    id={`${id}-fade`}
                    x1="-3"
                    x2="17"
                    y1="0"
                    y2="0"
                >
                    <stop offset="0" stopColor="#fff" stopOpacity="0" />
                    <stop offset=".55" stopColor="#fff" stopOpacity="1" />
                </linearGradient>
                <mask id={id}>
                    <rect fill={`url(#${id}-fade)`} height="24" width="20.2" x="-3" y="0" />
                </mask>
            </defs>
            <g mask={`url(#${id})`}>
                <path
                    className="edit-trail"
                    d={cursivePath(17, 18.5, 4, 1.55)}
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.6"
                />
            </g>
            <g className="edit-pen-bob">
                <g className="edit-pen-rock" style={pivotAt(17, 18.5)}>
                    <path
                        d="M17 18.5 19 16.67 16.65 15.81Z"
                        stroke="currentColor"
                        strokeLinejoin="round"
                        strokeWidth="1"
                    />
                    <path
                        d="M18.23 15.12 20.4 9.1"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeWidth="2.8"
                    />
                </g>
            </g>
        </GlyphFrame>
    );
}
