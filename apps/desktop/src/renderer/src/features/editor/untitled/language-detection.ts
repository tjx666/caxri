/**
 * Language detection for untitled buffers, following VS Code's `languageDetectionWebWorker.ts`: the
 * `@vscode/vscode-languagedetection` model ranks candidate languages by confidence, and the confidence is corrected for
 * languages that are common in an editor or known to cause false positives before the ranking is trusted.
 *
 * Every value here is VS Code's, so a buffer is detected the way a VS Code user expects.
 */
import type { EditorLanguageRegistration } from '../editor-language';
import { resolveRegisteredEditorLanguage } from '../editor-language';

/**
 * One model guess. `languageId` is the model's own identifier, which is a file extension (`py`, `ts`, `md`).
 */
export interface DetectedLanguage {
    languageId: string;
    confidence: number;
}

/**
 * The model returns nothing for shorter content, and VS Code skips the run.
 */
export const MIN_DETECTION_CONTENT_LENGTH = 20;
/**
 * VS Code reads at most this much of the buffer for detection.
 */
export const MAX_DETECTION_CONTENT_LENGTH = 10_000;
/**
 * Delay between an edit and the detection run, so a burst of typing runs the model once.
 */
export const DETECTION_DELAY_MS = 600;

const EXPECTED_RELATIVE_CONFIDENCE = 0.2;
const POSITIVE_CONFIDENCE_CORRECTION_BUCKET_1 = 0.05;
const POSITIVE_CONFIDENCE_CORRECTION_BUCKET_2 = 0.025;
const NEGATIVE_CONFIDENCE_CORRECTION = 0.5;

const bucket1 = new Set(['js', 'html', 'json', 'ts', 'css', 'py', 'xml', 'php']);
const bucket2 = new Set(['cpp', 'sh', 'java', 'cs', 'c']);
/**
 * Simple syntaxes that the model guesses too eagerly (VS Code issue 131912), so they need far more confidence.
 */
const penalized = new Set(['bat', 'ini', 'makefile', 'sql', 'csv', 'toml']);

function adjustConfidence(result: DetectedLanguage): DetectedLanguage {
    if (bucket1.has(result.languageId))
        return {
            ...result,
            confidence: result.confidence + POSITIVE_CONFIDENCE_CORRECTION_BUCKET_1,
        };
    if (bucket2.has(result.languageId))
        return {
            ...result,
            confidence: result.confidence + POSITIVE_CONFIDENCE_CORRECTION_BUCKET_2,
        };
    if (penalized.has(result.languageId))
        return { ...result, confidence: result.confidence - NEGATIVE_CONFIDENCE_CORRECTION };
    return result;
}

/**
 * The model languages worth trying, best first, from results sorted by descending confidence. A port of VS Code's
 * `detectLanguagesImpl`: nothing qualifies unless the top guess clears the threshold after correction, and a run of
 * close guesses is only offered once a clearly weaker guess separates it from the rest.
 */
export function rankDetectedLanguages(results: readonly DetectedLanguage[]): string[] {
    const top = results.at(0);
    if (!top || top.confidence < EXPECTED_RELATIVE_CONFIDENCE) return [];
    const first = adjustConfidence(top);
    if (first.confidence < EXPECTED_RELATIVE_CONFIDENCE) return [];
    const ranked: string[] = [];
    const possible: DetectedLanguage[] = [first];
    for (const next of results.slice(1)) {
        const current = adjustConfidence(next);
        const highest = possible.at(-1);
        if (!highest) break;
        const isSeparated = highest.confidence - current.confidence >= EXPECTED_RELATIVE_CONFIDENCE;
        if (isSeparated) {
            ranked.push(...possible.map(({ languageId }) => languageId));
            possible.length = 0;
        }
        if (current.confidence <= EXPECTED_RELATIVE_CONFIDENCE) return ranked;
        possible.push(current);
    }
    return ranked;
}

/**
 * Interpreters a shebang commonly names, mapped to the file extension of their language.
 */
const shebangExtensions: ReadonlyArray<[RegExp, string]> = [
    [/\b(?:python|python\d(?:\.\d+)?)\b/, 'py'],
    [/\b(?:node|deno|bun)\b/, 'js'],
    [/\b(?:bash|sh|zsh|ksh|dash)\b/, 'sh'],
    [/\bruby\b/, 'rb'],
    [/\bperl\b/, 'pl'],
    [/\bphp\b/, 'php'],
    [/\bfish\b/, 'fish'],
];

/**
 * The file extension the first line alone settles, the way VS Code's `firstLine` language contributions do: a shebang
 * names its interpreter, and an XML, HTML, or PHP preamble names its format. Runs before the model and also for content
 * too short for it.
 */
export function firstLineLanguageExtension(content: string): string | undefined {
    const firstLine = content.slice(0, !content.includes('\n') ? undefined : content.indexOf('\n'));
    if (firstLine.startsWith('#!')) {
        const interpreter = firstLine.slice(2);
        return shebangExtensions.find(([pattern]) => pattern.test(interpreter))?.[1];
    }
    const trimmed = firstLine.trimStart().toLowerCase();
    if (trimmed.startsWith('<?xml')) return 'xml';
    if (trimmed.startsWith('<?php')) return 'php';
    if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) return 'html';
    return undefined;
}

/**
 * The Monaco language for the first detected candidate Monaco has a registration for. Candidates are file extensions,
 * so each resolves the way a file named with it would.
 */
export function detectedEditorLanguage(
    candidates: readonly string[],
    registrations: readonly EditorLanguageRegistration[],
): string | undefined {
    for (const extension of candidates) {
        const language = resolveRegisteredEditorLanguage(`untitled.${extension}`, registrations);
        if (language) return language;
    }
    return undefined;
}
