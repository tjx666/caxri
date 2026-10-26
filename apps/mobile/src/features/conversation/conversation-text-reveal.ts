import type { RevealedRuns } from '@caxri/protocol';
import { initialRevealedRuns, nextRevealedRuns, revealedRunRanges } from '@caxri/protocol';
import type { ASTNode } from '@ronradtke/react-native-markdown-display';

/**
 * How long a run takes to fade from transparent to opaque, matching Desktop's `--motion-text-reveal`.
 */
const TEXT_REVEAL_MS = 500;

/**
 * Most fading runs one text node keeps. The phone redraws at most every 32ms, so the oldest of 24 arrived at least
 * 768ms ago, already opaque; Desktop's 90 assumes a redraw every frame.
 */
const MAX_FADING_RUNS = 24;

/**
 * Past this length a reply stops fading: every redraw re-parses the whole reply, and splitting its tail into faded
 * spans on top of that is where a long reply would start dropping frames on Android.
 */
export const TEXT_REVEAL_MAX_LENGTH = 2_000;

/**
 * The Markdown node type a revealing text node renders as, so its rule can split it into faded spans.
 */
export const FADING_TEXT_NODE = 'fading_text';

interface RevealingTextNode {
    runs: RevealedRuns;
    /**
     * When each run in `runs.ends` arrived, keyed by its end offset.
     */
    arrivals: ReadonlyMap<number, number>;
}

/**
 * The reveal state of a streaming reply's text nodes, by their order in the document. The Markdown renderer mints new
 * keys on every parse, so nothing inside the rendered tree survives a redraw; the order of text nodes is what stays put
 * as a reply only grows at its end.
 */
export type ConversationTextReveal = readonly RevealingTextNode[];

interface FadingRun {
    start: number;
    end: number;
    /**
     * From 0 (just arrived) toward 1.
     */
    opacity: number;
}

/**
 * A text node's settled prefix, shown as is, and the runs after it still fading in.
 */
export interface FadingText {
    settledEnd: number;
    runs: readonly FadingRun[];
}

/**
 * The text nodes of a parsed Markdown tree, in document order.
 */
export function markdownTextNodes(nodes: readonly ASTNode[]): ASTNode[] {
    const texts: ASTNode[] = [];
    const visit = (node: ASTNode): void => {
        if (node.type === 'text') texts.push(node);
        for (const child of node.children) visit(child);
    };
    for (const node of nodes) visit(node);
    return texts;
}

/**
 * Advances the reveal to the text nodes now on screen. A node that keeps its text keeps its state object, so a reply
 * that did not change returns `previous` itself. A node first seen within the mount grace shows at once, so a Chat
 * opened mid-reply does not fade in what was already there.
 */
export function nextConversationTextReveal(
    previous: ConversationTextReveal | undefined,
    texts: readonly string[],
    now: number,
    revealSince: number,
): ConversationTextReveal {
    let isChanged = previous?.length !== texts.length;
    const next = texts.map((text, index): RevealingTextNode => {
        const node = previous?.[index];
        if (!node) {
            isChanged = true;
            const runs = initialRevealedRuns(text, now, revealSince);
            return { runs, arrivals: new Map([[text.length, now]]) };
        }
        const runs = nextRevealedRuns(node.runs, text, MAX_FADING_RUNS);
        if (runs === node.runs) return node;
        isChanged = true;
        const arrivals = new Map<number, number>();
        for (const end of runs.ends) arrivals.set(end, node.arrivals.get(end) ?? now);
        return { runs, arrivals };
    });
    return isChanged || !previous ? next : previous;
}

/**
 * What one text node shows at `now`: runs that finished fading join the settled prefix, so a node that is done reads as
 * plain text.
 */
export function fadingText(node: RevealingTextNode, now: number): FadingText {
    const runs: FadingRun[] = [];
    let settledEnd = node.runs.settledEnd;
    for (const [start, end] of revealedRunRanges(node.runs)) {
        const opacity = Math.max(0, (now - (node.arrivals.get(end) ?? now)) / TEXT_REVEAL_MS);
        if (opacity >= 1 && runs.length === 0) {
            settledEnd = end;
            continue;
        }
        runs.push({ start, end, opacity: Math.min(1, opacity) });
    }
    return { settledEnd, runs };
}

/**
 * Whether any text node still has a run fading at `now`, so the reply needs another redraw to finish it.
 */
export function isConversationTextFading(reveal: ConversationTextReveal, now: number): boolean {
    return reveal.some((node) => fadingText(node, now).runs.length > 0);
}

/**
 * The parsed tree with every text node that still fades replaced by a `fading_text` node carrying what to draw, and
 * every other node shared as is. Returns `nodes` itself when nothing fades.
 */
export function withFadingTextNodes(
    nodes: ASTNode[],
    reveal: ConversationTextReveal,
    now: number,
): ASTNode[] {
    let index = 0;
    const visit = (node: ASTNode): ASTNode => {
        if (node.type === 'text') {
            const state = reveal.at(index);
            index += 1;
            const fading = state && fadingText(state, now);
            return fading?.runs.length
                ? ({ ...node, type: FADING_TEXT_NODE, fading } as ASTNode)
                : node;
        }
        if (node.children.length === 0) return node;
        const children = node.children.map(visit);
        return children.every((child, at) => child === node.children[at])
            ? node
            : { ...node, children };
    };
    const next = nodes.map(visit);
    return next.every((node, at) => node === nodes[at]) ? nodes : next;
}

/**
 * The fade a `fading_text` node carries, set by `withFadingTextNodes`.
 */
export function fadingTextOf(node: ASTNode): FadingText | undefined {
    return (node as ASTNode & { fading?: FadingText }).fading;
}

/**
 * `color` at `opacity`, for a run that fades in inside a nested `Text`, where a span cannot take its own `opacity`.
 * Only hex colors (the theme's) are blended; anything else shows opaque.
 */
export function colorWithOpacity(color: string, opacity: number): string {
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(color)?.[1];
    if (!hex) return color;
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
    const [red, green, blue] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
    return `rgba(${red}, ${green}, ${blue}, ${Math.round(opacity * 1000) / 1000})`;
}
