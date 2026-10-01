/**
 * Output validation for the interpretation layer — §13.1 and §6.21.
 *
 * §13 confines the model to explaining structured results, and this
 * implementation enforces that as *output validation* rather than as prompt
 * wording. A model that ignores every instruction it was given still cannot get
 * past these checks, which is the only form of the guarantee worth having: the
 * prompt is a request, and the gate is the control.
 *
 * A rejected response becomes an abstention. The reader is told the
 * explanation was withheld and why — not shown a blank panel, and not shown the
 * response with a warning, because a warned-about fabricated number is still a
 * fabricated number on the screen.
 */

import { claimIds, evidenceNumbers, type EvidenceObject, type InterpretationResponse } from './evidence';

export type RejectionCode =
  | 'MALFORMED'
  | 'UNCITED_CLAIM'
  | 'UNKNOWN_CLAIM_ID'
  | 'FABRICATED_NUMBER'
  | 'UNKNOWN_VOCABULARY'
  | 'CLINICAL_ADVICE'
  | 'CERTAINTY_CLAIM'
  | 'CAUSAL_OVERREACH'
  | 'EMPTY';

export interface GateVerdict {
  accepted: boolean;
  rejections: { code: RejectionCode; detail: string }[];
  /** The response, if accepted. */
  response: InterpretationResponse | null;
  /** What a reader is told when it was not accepted. */
  learnerMessage: string;
}

/**
 * Phrases that turn a research-use interpretation into clinical advice.
 *
 * §1.4 puts clinical recommendation and patient-specific dosing out of scope
 * and §13.1 forbids the experiment recommender from giving clinical
 * instructions. This is a blunt instrument and it is meant to be: the cost of a
 * false positive is one abstention, and the cost of a false negative is a lab
 * telling someone what to prescribe.
 */
const CLINICAL_PHRASES = [
  'should be prescribed', 'prescribe', 'treat the patient', 'in patients', 'clinical trial should',
  'recommended dose', 'dosing regimen', 'therapeutic dose for', 'administer to', 'contraindicated',
  'this patient', 'the patient should', 'clinically indicated', 'standard of care',
];

/**
 * Phrases asserting certainty the pipeline does not produce.
 *
 * Every model output here is a prediction with an uncertainty attached, and
 * §13.1 forbids presenting a hypothesis as proven fact. "Demonstrates",
 * "proves" and "confirms" are claims about evidence that a simulation cannot
 * make.
 */
const CERTAINTY_PHRASES = [
  'proves', 'proven', 'demonstrates that', 'confirms that', 'establishes that',
  'definitively', 'conclusively', 'without doubt', 'certainly', 'guaranteed',
  'will cure', 'is effective in', 'is the cause of',
];

/**
 * Causal language about proximity.
 *
 * §6.7 is explicit that proximity is an association. A sentence saying one cell
 * type "signals to" another on the basis of a neighbourhood statistic has
 * upgraded a correlation to a mechanism, and it reads as a finding.
 */
const CAUSAL_PHRASES = [
  'causes the', 'drives the', 'signals to', 'is responsible for', 'results in the',
  'leads directly to', 'triggers the',
];

export interface GateOptions {
  /** Relative tolerance when matching a number in the text to the evidence. */
  numericTolerance: number;
  /** Numbers below this are ignored — "one of the five cell types" is not a claim. */
  numericFloor: number;
  /** Allow a hypothesis section. Off for the baseline interpretation. */
  allowHypothesis: boolean;
}

export const DEFAULT_GATE: GateOptions = {
  numericTolerance: 0.02,
  numericFloor: 0,
  allowHypothesis: true,
};

export function validateResponse(
  raw: unknown,
  evidence: EvidenceObject,
  options: GateOptions = DEFAULT_GATE,
): GateVerdict {
  const rejections: { code: RejectionCode; detail: string }[] = [];

  const response = parse(raw);
  if (!response) {
    return {
      accepted: false,
      rejections: [{ code: 'MALFORMED', detail: 'The response was not valid JSON matching the required shape.' }],
      response: null,
      learnerMessage: withheldMessage('the model returned something this lab could not read as a structured interpretation'),
    };
  }

  // An abstention is a valid, useful answer and passes straight through.
  if (response.abstained) {
    return {
      accepted: true,
      rejections: [],
      response,
      learnerMessage: '',
    };
  }

  const statements = [
    ...response.findings,
    ...response.mechanism,
    ...response.candidateComparison,
  ];

  if (statements.length === 0 && response.limitations.length === 0) {
    rejections.push({ code: 'EMPTY', detail: 'The response contained no statements and did not abstain.' });
  }

  // -- citations ------------------------------------------------------------

  const known = claimIds(evidence);
  for (const entry of statements) {
    if (entry.citedClaims.length === 0) {
      rejections.push({
        code: 'UNCITED_CLAIM',
        detail: `"${truncate(entry.statement)}" cites no result id. §6.9 forbids free-text inference without result IDs.`,
      });
    }
    for (const id of entry.citedClaims) {
      if (!known.has(id)) {
        rejections.push({
          code: 'UNKNOWN_CLAIM_ID',
          detail: `"${truncate(entry.statement)}" cites ${id}, which is not in the evidence object.`,
        });
      }
    }
  }

  // -- numbers --------------------------------------------------------------

  const allowed = evidenceNumbers(evidence);
  const allText = [
    ...statements.map((entry) => entry.statement),
    ...response.limitations,
    ...(response.hypothesis ? [response.hypothesis.statement, response.hypothesis.howToTest] : []),
  ].join('\n');

  for (const candidate of extractNumbers(allText)) {
    // Each candidate is a set of readings of one written figure — "12%" reads
    // as 12 and as 0.12 — and it passes if ANY reading is in the evidence.
    // Requiring every reading to match rejects every percentage ever written.
    if (candidate.readings.every((value) => Math.abs(value) < options.numericFloor)) continue;
    const matches = candidate.readings.some((reading) =>
      allowed.some((value) => closeEnough(reading, value, options.numericTolerance)),
    );
    if (!matches) {
      rejections.push({
        code: 'FABRICATED_NUMBER',
        detail:
          `The response contains ${candidate.written}, which does not appear in the evidence object. ` +
          '§1.4 puts LLM-generated numerical biology out of scope entirely.',
      });
    }
  }

  // -- vocabulary -----------------------------------------------------------

  const vocabulary = new Set(
    [
      ...evidence.vocabulary.features,
      ...evidence.vocabulary.cellTypes,
      ...evidence.vocabulary.regions,
      ...evidence.vocabulary.pathways,
      ...evidence.vocabulary.candidates,
    ].map((term) => term.toUpperCase()),
  );

  for (const token of extractGeneLikeTokens(allText)) {
    if (!vocabulary.has(token.toUpperCase())) {
      rejections.push({
        code: 'UNKNOWN_VOCABULARY',
        detail:
          `The response names "${token}", which is not a feature, cell type, region, pathway or candidate in this run. ` +
          'A model naming a gene the dataset does not measure is describing a different experiment.',
      });
    }
  }

  // -- prohibited registers -------------------------------------------------

  const lower = allText.toLowerCase();
  for (const phrase of CLINICAL_PHRASES) {
    if (lower.includes(phrase)) {
      rejections.push({ code: 'CLINICAL_ADVICE', detail: `The response contains "${phrase}". This is a research-use platform (§1.4).` });
    }
  }
  for (const phrase of CERTAINTY_PHRASES) {
    if (lower.includes(phrase)) {
      rejections.push({ code: 'CERTAINTY_CLAIM', detail: `The response contains "${phrase}", asserting a certainty the pipeline does not produce.` });
    }
  }
  for (const phrase of CAUSAL_PHRASES) {
    if (lower.includes(phrase)) {
      rejections.push({
        code: 'CAUSAL_OVERREACH',
        detail: `The response contains "${phrase}". §6.7 requires proximity and co-expression to be described as association.`,
      });
    }
  }

  if (!options.allowHypothesis && response.hypothesis) {
    rejections.push({ code: 'EMPTY', detail: 'A hypothesis was returned for a stage that does not accept one.' });
  }

  const accepted = rejections.length === 0;
  return {
    accepted,
    rejections,
    response: accepted ? response : null,
    learnerMessage: accepted ? '' : withheldMessage(describe(rejections)),
  };
}

function describe(rejections: { code: RejectionCode; detail: string }[]): string {
  const codes = [...new Set(rejections.map((r) => r.code))];
  const reasons: Record<RejectionCode, string> = {
    MALFORMED: 'it was not in the required structure',
    UNCITED_CLAIM: 'it made a statement without citing a result',
    UNKNOWN_CLAIM_ID: 'it cited a result that does not exist in this run',
    FABRICATED_NUMBER: 'it contained a number that does not appear anywhere in this run’s results',
    UNKNOWN_VOCABULARY: 'it named something this dataset does not measure',
    CLINICAL_ADVICE: 'it strayed into clinical advice, which this platform does not give',
    CERTAINTY_CLAIM: 'it asserted a certainty the analysis does not support',
    CAUSAL_OVERREACH: 'it described an association as a cause',
    EMPTY: 'it contained nothing to show',
  };
  return codes.map((code) => reasons[code]).join('; and ');
}

function withheldMessage(reason: string): string {
  return (
    `The AI explanation was withheld because ${reason}. ` +
    'Everything above it is unaffected: the numbers, maps and comparisons are computed by the analysis engine and do not pass through any language model.'
  );
}

function parse(raw: unknown): InterpretationResponse | null {
  let value = raw;
  if (typeof raw === 'string') {
    // A fenced block is the most common wrapper, and unwrapping it is not
    // leniency about content — the gate below is unchanged either way.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    const text = fenced?.[1] ?? raw;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const section = (key: string): { statement: string; citedClaims: string[] }[] => {
    const entries = record[key];
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      .map((entry) => ({
        statement: typeof entry.statement === 'string' ? entry.statement : '',
        citedClaims: Array.isArray(entry.citedClaims) ? entry.citedClaims.filter((id): id is string => typeof id === 'string') : [],
      }))
      .filter((entry) => entry.statement.trim() !== '');
  };

  const hypothesisRaw = record.hypothesis;
  let hypothesis: InterpretationResponse['hypothesis'] = null;
  if (typeof hypothesisRaw === 'object' && hypothesisRaw !== null) {
    const fields = hypothesisRaw as Record<string, unknown>;
    if (typeof fields.statement === 'string' && fields.statement.trim() !== '') {
      hypothesis = {
        statement: fields.statement,
        howToTest: typeof fields.howToTest === 'string' ? fields.howToTest : '',
      };
    }
  }

  return {
    findings: section('findings'),
    mechanism: section('mechanism'),
    candidateComparison: section('candidateComparison'),
    limitations: Array.isArray(record.limitations)
      ? record.limitations.filter((entry): entry is string => typeof entry === 'string')
      : [],
    hypothesis,
    abstained: record.abstained === true,
    abstentionReason: typeof record.abstentionReason === 'string' ? record.abstentionReason : null,
  };
}

/**
 * Numbers in the text.
 *
 * Identifier-shaped tokens are stripped first, and that is not a refinement —
 * without it the gate rejects its own happy path. Gene symbols carry digits:
 * SMAD3, CDH1, MAP2K1, CA9, CDK4/6. A raw scan finds the 3 in SMAD3, fails to
 * find 3 in the evidence, and refuses a perfectly correct sentence for
 * containing a fabricated number. Removing anything that starts with a letter
 * and continues as a symbol leaves the actual figures behind: `1.2e-4` begins
 * with a digit and survives, `SMAD3` does not.
 *
 * Percentages are captured both as written and as a fraction, because "12%" in
 * the text and 0.12 in the evidence are the same claim.
 */
export interface NumberCandidate {
  /** The figure exactly as it was written, for the rejection message. */
  written: string;
  /** Every reading of it. A percentage has two; everything else has one. */
  readings: number[];
}

export function extractNumbers(text: string): NumberCandidate[] {
  const withoutSymbols = text.replace(/\b[A-Za-z][A-Za-z0-9]*(?:[/\-][A-Za-z0-9]+)*/g, ' ');
  const out: NumberCandidate[] = [];
  const pattern = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?%?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutSymbols)) !== null) {
    const raw = match[0];
    if (raw.endsWith('%')) {
      const value = Number.parseFloat(raw.slice(0, -1));
      if (Number.isFinite(value)) out.push({ written: raw, readings: [value, value / 100] });
    } else {
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value)) out.push({ written: raw, readings: [value] });
    }
  }
  return out;
}

/** Tokens that look like gene or protein symbols. */
export function extractGeneLikeTokens(text: string): string[] {
  const tokens = new Set<string>();
  // Two or more characters, at least one digit or three-plus capitals — which
  // is what a symbol looks like and what ordinary prose does not.
  const pattern = /\b([A-Z][A-Z0-9]{2,}[0-9]?[A-Z0-9]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[1] as string;
    if (COMMON_ACRONYMS.has(token)) continue;
    tokens.add(token);
  }
  return [...tokens];
}

/**
 * Words that look like symbols and are not.
 *
 * Without this list the gate rejects a perfectly good response for saying
 * "RNA" or "PREDICTED", which is an abstention nobody learns anything from.
 */
const COMMON_ACRONYMS = new Set([
  'RNA', 'DNA', 'CRISPR', 'PCR', 'QPCR', 'ELISA', 'FACS', 'GNN', 'AI', 'ML',
  'OBSERVED', 'COMPUTED', 'PREDICTED', 'INTERPRETED', 'HYPOTHESIS', 'VALIDATION',
  'PASS', 'WARNING', 'FAIL', 'QC', 'FDR', 'MAD', 'PCA', 'UMAP', 'TSNE',
  'CAF', 'CAFS', 'TME', 'EMT', 'IHC', 'MRNA', 'CDNA', 'KO', 'WT', 'ATP',
  'NOTE', 'NOT', 'AND', 'THE', 'FOR', 'ALL', 'ANY', 'ONE', 'TWO', 'ARE',
]);

/**
 * Whether a number in the text corresponds to one in the evidence.
 *
 * Magnitude matches as well as signed: "SMAD3 falls by 0.073" is a correct
 * rendering of a change of -0.073, and it is how anybody would write it. The
 * direction is carried by the verb and the signed value is on screen in the
 * evidence panel beside the sentence, so accepting the magnitude costs nothing
 * and rejecting it would make natural phrasing impossible.
 */
function closeEnough(a: number, b: number, tolerance: number): boolean {
  if (matchesExactly(a, b, tolerance)) return true;
  return matchesExactly(Math.abs(a), Math.abs(b), tolerance);
}

function matchesExactly(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return true;
  if (Math.abs(a - b) / scale <= tolerance) return true;
  // A rounded quotation of a longer value: 0.0234 quoted as 0.02.
  const decimals = decimalPlaces(a);
  return Math.abs(round(b, decimals) - a) < Number.EPSILON * 16;
}

function decimalPlaces(value: number): number {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function truncate(text: string, length = 70): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}
