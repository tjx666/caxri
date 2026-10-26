interface EvidenceRequirement {
    type: string;
    source?: string;
}

interface CitedEvidence {
    path: string;
    type: string;
    source?: string;
}

function isSatisfiedBy(cited: CitedEvidence, required: EvidenceRequirement): boolean {
    return cited.type === required.type && (!required.source || cited.source === required.source);
}

/**
 * A cited file of the right medium whose evidence entry names no or another `source` reads, in the bare "missing"
 * message, as if the capture never happened, although the device receipt already records its framebuffer source. Name
 * the entry and the field to set instead.
 */
function sourceHint(required: EvidenceRequirement, cited: readonly CitedEvidence[]): string {
    const candidate = required.source && cited.find(({ type }) => type === required.type);
    if (!candidate) return '';
    const declared = candidate.source
        ? `declares "source": "${candidate.source}"`
        : 'has no "source"';
    return ` (the evidence entry for ${candidate.path} ${declared}; set "source": "${required.source}" on it)`;
}

/**
 * Fails a non-blocked case whose cited evidence lacks a medium the frozen plan requires.
 */
export function assertRequiredEvidence(
    caseId: string,
    requirements: readonly EvidenceRequirement[],
    cited: readonly CitedEvidence[],
): void {
    const missing = requirements.filter((required) =>
        cited.every((item) => !isSatisfiedBy(item, required)),
    );
    if (missing.length === 0) return;
    const labels = missing.map((required) =>
        required.source
            ? `${required.type}:${required.source}${sourceHint(required, cited)}`
            : required.type,
    );
    throw new Error(`Case ${caseId} is missing required evidence: ${labels.join(', ')}`);
}
