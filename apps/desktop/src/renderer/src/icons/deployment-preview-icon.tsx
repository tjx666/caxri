import type { SVGProps } from 'react';

/**
 * An eye with a magnifier distinguishes preview inspection from the hidden-state eye-off glyph. Visual reference:
 * https://vercel.com/geist/icons
 */
export function DeploymentPreviewIcon({
    size = 16,
    ...properties
}: SVGProps<SVGSVGElement> & { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...properties}
        >
            <path d="M8.5 11C5.3 11.3 2.8 10 1 7.5C4 2.5 11 2.5 14.5 7.5C13.7 8.8 12.7 9.7 11.5 10.3" />
            <circle cx="7.25" cy="7.25" r="2.5" />
            <path d="m9.05 9.05 3.2 3.2" />
        </svg>
    );
}
