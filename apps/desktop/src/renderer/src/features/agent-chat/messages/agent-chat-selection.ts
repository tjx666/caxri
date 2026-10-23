/**
 * Selected transcript text as a Markdown quote, the form an Agent reads as "the part of the conversation I mean". Each
 * line is quoted, blank lines keep the quote one block, and surrounding blank lines are dropped. Empty for a selection
 * of whitespace alone.
 */
export function agentChatSelectionQuote(text: string): string {
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
    return lines.map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>')).join('\n');
}
