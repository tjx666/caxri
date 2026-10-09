const escape = '\u{1B}';
const response = new RegExp(
    `^(?:${escape}(?:${String.raw`\[(?:[?>][\d;]+c|\??\d+;\d+R|0n|[IO]|[468];\d+;\d+t|\??\d+;[0-4]\$y|\?\d+u|\?997;[12]n)`}|${String.raw`\](?:[12]\d|4;\d+);rgb:[\da-fA-F]{1,4}/[\da-fA-F]{1,4}/[\da-fA-F]{1,4}`}(?:${escape}\\\\|\u{7})` +
        `|${String.raw`P>\|xterm\.js\([\w.+-]+\)`}${escape}\\\\` +
        `))+$`,
);

/**
 * Xterm emits capability, cursor, color and focus replies through the same onData channel as keys. These closed
 * protocol responses must not claim human takeover or suspend an Agent. Unknown or mixed input stays human input. See
 * https://github.com/xtermjs/xterm.js/blob/master/src/common/InputHandler.ts.
 */
export function isTerminalProtocolResponse(data: string): boolean {
    return data.length === 0 || response.test(data);
}

const mouseReport = new RegExp(`^(?:${escape}${String.raw`\[<\d+;\d+;\d+m`})+$`, 'i');

/**
 * Codex and other full-screen Agents enable SGR mouse tracking (`?1006h`), so xterm reports every wheel tick and click
 * in the Terminal as `ESC[<button;column;rowM` text on the same onData channel as keys. Reading an Agent's progress is
 * not typing into it: counted as input, a scroll marked a delegated task "Taken over by you" and kept the Agent
 * Commander's completion notices queued as an unsent draft. The legacy X10 encoding already arrives as binary input,
 * which never moves the input epoch. See
 * https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Extended-coordinates.
 */
export function isTerminalMouseReport(data: string): boolean {
    return mouseReport.test(data);
}
