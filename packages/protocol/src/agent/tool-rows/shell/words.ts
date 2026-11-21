/**
 * Splits one simple command into words, honoring single and double quotes. Returns `null` for anything a word split
 * cannot read faithfully: a redirection, a substitution, or a variable.
 */
export function splitWords(command: string): string[] | null {
    const words: string[] = [];
    let word = '';
    let hasWord = false;
    let quote: '"' | "'" | undefined;
    for (const char of command) {
        if (quote) {
            if (char === quote) quote = undefined;
            else word += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            hasWord = true;
            continue;
        }
        if (/[<>`$(){}]/u.test(char)) return null;
        if (/\s/u.test(char)) {
            if (hasWord) words.push(word);
            word = '';
            hasWord = false;
            continue;
        }
        word += char;
        hasWord = true;
    }
    if (quote) return null;
    if (hasWord) words.push(word);
    return words;
}

/**
 * Splits on unquoted list operators (`&&`, `;`, a newline) into commands, and each command on unquoted pipes into its
 * stages. Returns `null` for `||` and for an empty command, which no single action describes.
 */
export function splitList(command: string): string[][] | null {
    const commands: string[][] = [];
    let stages: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    let index = 0;
    const didEnd = (isCommandEnd: boolean): boolean => {
        stages.push(current.trim());
        current = '';
        if (stages.includes('')) return false;
        if (isCommandEnd) {
            commands.push(stages);
            stages = [];
        }
        return true;
    };
    while (index < command.length) {
        const char = command[index] ?? '';
        if (quote) {
            if (char === quote) quote = undefined;
            current += char;
            index += 1;
            continue;
        }
        if (char === '"' || char === "'") quote = char;
        if (command.startsWith('||', index)) return null;
        const operator = ['&&', ';', '\n', '|'].find((op) => command.startsWith(op, index));
        if (operator && !quote) {
            // A trailing `;` or newline ends the last command without starting another.
            if (operator !== '|' && current.trim() === '' && stages.length === 0) {
                index += operator.length;
                continue;
            }
            if (!didEnd(operator !== '|')) return null;
            index += operator.length;
            continue;
        }
        current += char;
        index += 1;
    }
    if (quote) return null;
    if ((current.trim() !== '' || stages.length > 0) && !didEnd(true)) return null;
    return commands.length > 0 ? commands : null;
}
