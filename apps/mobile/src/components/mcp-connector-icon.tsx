import Svg, { Circle, Path } from 'react-native-svg';

import type { LucideProps } from 'lucide-react-native';

/**
 * The glyph an MCP tool call shows when its server has no icon of its own: four connected nodes, the shape the Codex
 * app gives an unnamed connector. A port of Desktop's `McpConnectorIcon`, drawn on Lucide's 24px grid and stroke so it
 * sits beside the other tool glyphs and takes the same props.
 */
export const McpConnectorIcon = ({
    color = 'currentColor',
    size = 24,
    strokeWidth = 2,
}: LucideProps) => (
    <Svg
        fill="none"
        height={size}
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        viewBox="0 0 24 24"
        width={size}
    >
        <Circle cx="6" cy="6" r="3" />
        <Circle cx="18" cy="6" r="3" />
        <Circle cx="6" cy="18" r="3" />
        <Circle cx="18" cy="18" r="3" />
        <Path d="M15.88 8.12 8.12 15.88" />
    </Svg>
);
