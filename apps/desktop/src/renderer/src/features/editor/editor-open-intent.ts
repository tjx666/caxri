/**
 * A file open awaits `files.read` before it activates its tab, so a slower open can resolve after the user already
 * moved on. Every open, every explicit tab selection, and every synchronous tab open (Settings, diffs, Preview)
 * advances this counter; an open whose token is no longer current when its read resolves must not activate anything.
 */
const fileOpenIntent = { current: 0 };

export function beginFileOpenIntent(): number {
    fileOpenIntent.current += 1;
    return fileOpenIntent.current;
}

export function isCurrentFileOpenIntent(intent: number): boolean {
    return intent === fileOpenIntent.current;
}

/**
 * Selecting an already-open tab or opening a virtual tab never goes through `openFileForSession`, so those paths
 * supersede pending opens here.
 */
export function supersedePendingFileOpens(): void {
    fileOpenIntent.current += 1;
}
