import { clip } from '../../chat-items';

/**
 * Claude Code's Chrome integration (`claude --chrome`) drives the browser through the `claude-in-chrome` MCP server, so
 * its steps arrive as `mcp__claude-in-chrome__<tool>` calls with JSON arguments. The Chat names them `browserUse`, the
 * same tool Codex browser steps map to (see `codex-computer-use.ts`), so the shared tool table in `@caxri/protocol`
 * shows a globe, titles the row by this title, and counts it among "browser steps" in a work group.
 *
 * @see https://code.claude.com/docs/en/chrome
 */
const CHROME_TOOL_PREFIX = 'mcp__claude-in-chrome__';

type Json = Record<string, unknown>;

function field(input: Json, key: string): string | undefined {
    const value = input[key];
    if (typeof value === 'string') return value.trim() || undefined;
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/**
 * What a pointer action aimed at: the element reference the model found, or the viewport point it clicked.
 */
function target(input: Json): string | undefined {
    const reference = field(input, 'ref');
    if (reference) return reference;
    const point = input.coordinate;
    return Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === 'number')
        ? `at (${point[0]}, ${point[1]})`
        : undefined;
}

const withTarget = (verb: string, input: Json): string => {
    const aimed = target(input);
    return aimed ? `${verb} ${aimed}` : verb;
};

const POINTER_VERBS: Partial<Record<string, string>> = {
    left_click: 'Click',
    right_click: 'Right-click',
    double_click: 'Double-click',
    triple_click: 'Triple-click',
    hover: 'Hover',
    left_click_drag: 'Drag',
    scroll_to: 'Scroll to',
};

/**
 * The `computer` tool's `action` as a sentence: `Click ref_12`, `Type "hello"`, `Press cmd+l`.
 */
function computerTitle(input: Json): string {
    const action = field(input, 'action') ?? '';
    const pointer = POINTER_VERBS[action];
    if (pointer) return withTarget(pointer, input);
    const typed = field(input, 'text');
    switch (action) {
        case 'type': {
            return typed ? `Type "${typed}"` : 'Type';
        }
        case 'key': {
            return typed ? `Press ${typed}` : 'Press a key';
        }
        case 'screenshot': {
            return 'Take a screenshot';
        }
        case 'zoom': {
            return 'Zoom in on the page';
        }
        case 'wait': {
            const duration = field(input, 'duration');
            return duration ? `Wait ${duration}s` : 'Wait';
        }
        case 'scroll': {
            const direction = field(input, 'scroll_direction');
            return direction ? `Scroll ${direction}` : 'Scroll';
        }
        default: {
            return action ? humanize(action) : 'Use the browser';
        }
    }
}

function navigateTitle(input: Json): string {
    const url = field(input, 'url');
    if (url === 'back') return 'Go back';
    if (url === 'forward') return 'Go forward';
    return url ? `Open ${url}` : 'Open a page';
}

/**
 * A tool name this table does not know, as words: `read_console_messages` reads `Read console messages`. The `_mcp`
 * suffix some tools carry only disambiguates them from built-in tools.
 */
function humanize(name: string): string {
    const words = name.replace(/_mcp$/u, '').replaceAll('_', ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Use the browser';
}

const TITLES: Partial<Record<string, (input: Json) => string>> = {
    navigate: navigateTitle,
    computer: computerTitle,
    find: (input) => {
        const query = field(input, 'query');
        return query ? `Find ${query}` : 'Find on the page';
    },
    form_input: (input) => {
        const reference = field(input, 'ref');
        if (!reference) return 'Fill a form field';
        const value = field(input, 'value');
        return value === undefined ? `Fill ${reference}` : `Fill ${reference} with "${value}"`;
    },
    read_page: () => 'Read the page',
    get_page_text: () => 'Read the page text',
    javascript_tool: () => 'Run JavaScript',
    tabs_context_mcp: () => 'Check open tabs',
    tabs_create_mcp: () => 'Open a new tab',
    resize_window: (input) => {
        const width = field(input, 'width');
        const height = field(input, 'height');
        return width && height ? `Resize the window to ${width}x${height}` : 'Resize the window';
    },
    gif_creator: () => 'Record a GIF',
    upload_image: () => 'Upload an image',
};

/**
 * The row title of a Claude in Chrome call, or `undefined` for any other tool.
 */
export function claudeChromeTitle(name: string, input: Json): string | undefined {
    if (!name.startsWith(CHROME_TOOL_PREFIX)) return undefined;
    const tool = name.slice(CHROME_TOOL_PREFIX.length);
    return clip(TITLES[tool]?.(input) ?? humanize(tool), 1_000);
}
