import { errorMessage } from '@caxri/protocol';

import type { DetectedLanguage } from './language-detection';
import {
    DETECTION_DELAY_MS,
    firstLineLanguageExtension,
    MAX_DETECTION_CONTENT_LENGTH,
    MIN_DETECTION_CONTENT_LENGTH,
    rankDetectedLanguages,
} from './language-detection';
import type {
    LanguageDetectionRequest,
    LanguageDetectionResponse,
} from './language-detection.worker';
import LanguageDetectionWorker from './language-detection.worker?worker';
import { useUntitledLanguageStore } from './language-store';

interface PendingDetection {
    resolve(results: DetectedLanguage[]): void;
    reject(error: Error): void;
}

const pending = new Map<number, PendingDetection>();
const detector: {
    worker?: Worker;
    nextRequestId: number;
    /**
     * Set once the model failed to load or run, as VS Code's `_loadFailed`: later edits keep their current language
     * instead of retrying a model that cannot run.
     */
    hasModelFailed: boolean;
} = { nextRequestId: 1, hasModelFailed: false };

function detectionWorker(): Worker {
    if (detector.worker) return detector.worker;
    const created = new LanguageDetectionWorker();
    created.addEventListener('message', (event: MessageEvent<LanguageDetectionResponse>) => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id);
        if ('error' in event.data) entry.reject(new Error(event.data.error));
        else entry.resolve(event.data.results);
    });
    /**
     * A Worker that fails to load its script or decode a reply never answers; settle every waiting request so detection
     * stops instead of hanging until the next edit.
     */
    const failAll = () => {
        detector.hasModelFailed = true;
        for (const entry of pending.values())
            entry.reject(new Error('Language detection Worker failed'));
        pending.clear();
    };
    created.addEventListener('error', failAll);
    created.addEventListener('messageerror', failAll);
    detector.worker = created;
    return created;
}

function runModel(content: string): Promise<DetectedLanguage[]> {
    const id = detector.nextRequestId;
    detector.nextRequestId += 1;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        detectionWorker().postMessage({ id, content } satisfies LanguageDetectionRequest);
    });
}

/**
 * The detected language candidates for `content`, best first; empty when nothing is confident enough.
 */
async function detectLanguageCandidates(content: string): Promise<string[]> {
    const firstLine = firstLineLanguageExtension(content);
    if (firstLine) return [firstLine];
    const sample = content.slice(0, MAX_DETECTION_CONTENT_LENGTH);
    if (detector.hasModelFailed || sample.trim().length < MIN_DETECTION_CONTENT_LENGTH) return [];
    try {
        return rankDetectedLanguages(await runModel(sample));
    } catch (error) {
        detector.hasModelFailed = true;
        console.warn('Language detection failed', errorMessage(error, 'unknown error'));
        return [];
    }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * The newest content scheduled per buffer, so a slow run that finishes after a newer edit does not overwrite it.
 */
const latestContent = new Map<string, string>();

/**
 * Detects the language of an untitled buffer `DETECTION_DELAY_MS` after its last edit, as VS Code does. An emptied
 * buffer returns to Plain Text at once; content the model is not confident about keeps the current language, so a
 * half-typed line does not flicker the highlighting.
 */
export function scheduleUntitledLanguageDetection(key: string, content: string): void {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    latestContent.set(key, content);
    if (content.trim() === '') {
        timers.delete(key);
        useUntitledLanguageStore.getState().clear(key);
        return;
    }
    timers.set(
        key,
        setTimeout(() => {
            timers.delete(key);
            void detectLanguageCandidates(content).then((candidates) => {
                if (latestContent.get(key) !== content || candidates.length === 0) return;
                useUntitledLanguageStore.getState().setCandidates(key, candidates);
            });
        }, DETECTION_DELAY_MS),
    );
}

/**
 * Forgets an untitled buffer that was saved or closed.
 */
export function forgetUntitledLanguage(key: string): void {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.delete(key);
    latestContent.delete(key);
    useUntitledLanguageStore.getState().clear(key);
}
