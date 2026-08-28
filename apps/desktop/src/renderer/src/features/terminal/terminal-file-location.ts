import type { EditorNavigationTarget } from '@caxri/protocol';

export const TERMINAL_FILE_LOCATION_SUFFIX_PATTERN =
    /(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)(?=$|[\s.,;:!?"'`)\]}、，。；：！？])/g;

function positiveLine(value: string | undefined): number | undefined {
    if (!value) return;
    const line = Number(value);
    return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

/**
 * Separates an exact Terminal location suffix from its path and normalizes the navigation intent. Location-shaped but
 * invalid suffixes stay distinguishable from ordinary `#` filenames so callers can reject them instead of opening a
 * misleading literal path.
 */
export function parseTerminalFileLocation(text: string): {
    invalidLocation?: true;
    location?: EditorNavigationTarget;
    target: string;
} {
    const colon = /^(.*?):(\d+)(?::(\d+))?$/.exec(text);
    if (colon?.[1]) {
        const line = positiveLine(colon[2]);
        if (!line) return { target: colon[1], invalidLocation: true };
        const columnSource = colon.at(3);
        const column = columnSource ? positiveLine(columnSource) : undefined;
        if (!column && columnSource) return { target: colon[1], invalidLocation: true };
        return {
            target: colon[1],
            location: column
                ? { mode: 'caret', line, column }
                : { mode: 'line', startLine: line, endLine: line },
        };
    }
    const github = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(text);
    if (!github?.[1]) {
        const incomplete = /^(.*?)#L\d+(?:-L?\d*)?$/.exec(text);
        return incomplete?.[1]
            ? { target: incomplete[1], invalidLocation: true }
            : { target: text };
    }
    const startLine = positiveLine(github[2]);
    const endLine = positiveLine(github.at(3) ?? github[2]);
    if (!startLine || !endLine || endLine < startLine)
        return { target: github[1], invalidLocation: true };
    return {
        target: github[1],
        location: { mode: 'line', startLine, endLine },
    };
}
