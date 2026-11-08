/**
 * Widths are counted in tenths of an em at the tile's 12px name size: a CJK, full-width, or emoji character fills a
 * whole em, and anything else about 0.6em (the system font's digits and lowercase letters).
 */
const WIDE_WIDTH = 10;
const NARROW_WIDTH = 6;
/**
 * What a tile's two name lines hold: each line is about 8.3em (100px at 12px), less a little for where a line breaks.
 */
const TILE_NAME_WIDTH = 155;
/**
 * The width of the name's end kept before its extension, so two files sharing a long prefix still read apart.
 */
const TAIL_WIDTH = 40;

function characterWidth(character: string): number {
    return (character.codePointAt(0) ?? 0) >= 0x2e_80 ? WIDE_WIDTH : NARROW_WIDTH;
}

function width(characters: readonly string[]): number {
    return characters.reduce((total, character) => total + characterWidth(character), 0);
}

/**
 * A file or folder name shortened in the middle to fit a Finder-style tile's two lines, as Finder's icon view shortens
 * one (`Roadmap 草案 fo… 下半年.pdf`): the start, an ellipsis, the last few characters, and the whole extension, so the type
 * always shows. A name that fits is returned as is. The width is an estimate; the tile still clamps to two lines in
 * case a line breaks early at a space.
 */
export function agentChatFileTileName(name: string, maxWidth = TILE_NAME_WIDTH): string {
    const characters = [...name];
    if (width(characters) <= maxWidth) return name;
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 8 ? [...name.slice(dot)] : [];
    const stem = characters.slice(0, characters.length - extension.length);
    const tail: string[] = [];
    while (stem.length > 0 && width(tail) + characterWidth(stem.at(-1) ?? '') <= TAIL_WIDTH)
        tail.unshift(stem.pop() ?? '');
    const budget = maxWidth - NARROW_WIDTH - width(tail) - width(extension);
    const head: string[] = [];
    for (const character of stem) {
        if (width(head) + characterWidth(character) > budget) break;
        head.push(character);
    }
    return `${head.join('')}…${tail.join('')}${extension.join('')}`;
}
