/**
 * The interpretation adapter: one provider call, audited, behind the gate.
 *
 * Three properties matter more than which provider is configured.
 *
 * The key never reaches the browser. Every model call originates here, in the
 * server process, and the client receives only a validated interpretation.
 *
 * With no provider configured the lab is complete. Every number, map,
 * comparison and uncertainty figure is produced by the analysis engine and
 * involves no model at all; the interpretation panel says it is unavailable and
 * nothing else changes. §13 makes the AI an explainer, and an explainer is by
 * definition optional.
 *
 * Everything is audited. Prompt, raw response, gate verdict and latency go to
 * `ai-audit.jsonl`, so a disputed interpretation can be reconstructed rather
 * than argued about.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import { validateResponse, type GateVerdict } from './gate';
import { RESPONSE_SHAPE_DESCRIPTION, type EvidenceObject, type InterpretationResponse } from './evidence';

export type InterpretationStage = 'baseline' | 'final' | 'validation-plan';

export interface InterpretationRequest {
  runId: string;
  userId: string;
  stage: InterpretationStage;
  evidence: EvidenceObject;
}

export interface InterpretationResult {
  available: boolean;
  /** Present when the gate accepted a response. */
  response: InterpretationResponse | null;
  /** What the reader is told when there is no interpretation. */
  message: string;
  /** Why it is unavailable or was withheld, for the operator. */
  detail: string | null;
  model: string;
  promptVersion: string;
  policyVersion: string;
  gate: { accepted: boolean; rejections: GateVerdict['rejections'] } | null;
  milliseconds: number;
}

const SYSTEM_PROMPT = `You are the interpretation layer of a research-use spatial-omics analysis platform.

You are given a structured evidence object containing results the platform computed. Your job is to
explain those results. You are not a source of biological knowledge here and nothing you know that is
not in the evidence object may enter your answer.

Absolute rules:
1. Never state a number that is not in the evidence object. Not an estimate, not a rounding of
   something similar, not a value you believe to be typical.
2. Never name a gene, protein, pathway, cell type, region or compound that is not in the vocabulary
   given to you.
3. Every statement must cite at least one claim id from the evidence.
4. Describe spatial proximity and co-expression as association. They are not evidence of signalling.
5. Never give clinical advice, dosing guidance, or anything about patients. This is research use.
6. Never claim something is proven, confirmed, definitive or certain. Every model output here is a
   prediction with an uncertainty attached.
7. If the evidence does not support an interpretation, set "abstained" to true and say why. That is
   a correct and useful answer, not a failure.

Answer with JSON matching exactly this shape and nothing else:
${RESPONSE_SHAPE_DESCRIPTION}`;

export class AiAdapter {
  private readonly auditPath: string;
  private readonly callsByUser = new Map<string, number[]>();

  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true });
    this.auditPath = join(dataRoot, 'ai-audit.jsonl');
  }

  get available(): boolean {
    return config.ai.enabled && (config.ai.apiKey !== '' || config.ai.baseUrl !== '');
  }

  get unavailableReason(): string | null {
    if (!config.ai.enabled) {
      return 'AI interpretation is switched off for this deployment. Every number, map and comparison in this lab is computed by the analysis engine and is unaffected.';
    }
    if (config.ai.apiKey === '' && config.ai.baseUrl === '') {
      return 'AI interpretation is enabled but no provider is configured, so the adapter abstains on every request. Every number, map and comparison is unaffected.';
    }
    return null;
  }

  async interpret(request: InterpretationRequest): Promise<InterpretationResult> {
    const started = Date.now();
    const base: Omit<InterpretationResult, 'available' | 'response' | 'message' | 'detail' | 'gate' | 'milliseconds'> = {
      model: config.ai.model,
      promptVersion: config.ai.promptVersion,
      policyVersion: config.ai.policyVersion,
    };

    const unavailable = this.unavailableReason;
    if (unavailable) {
      return { ...base, available: false, response: null, message: unavailable, detail: null, gate: null, milliseconds: 0 };
    }

    if (request.evidence.notInterpretable) {
      return {
        ...base,
        available: true,
        response: null,
        message: request.evidence.notInterpretable,
        detail: 'The run itself reported that it cannot support an interpretation, so no model was called.',
        gate: null,
        milliseconds: 0,
      };
    }

    if (!this.allow(request.userId)) {
      return {
        ...base,
        available: true,
        response: null,
        message: `You have reached this hour's limit of ${config.ai.rateLimitPerHour} interpretations. The analysis results are unaffected.`,
        detail: 'rate limit',
        gate: null,
        milliseconds: 0,
      };
    }

    const userPrompt = JSON.stringify(request.evidence);
    let raw: string | null = null;
    let transportError: string | null = null;

    try {
      raw = await this.call(SYSTEM_PROMPT, userPrompt);
    } catch (error) {
      transportError = error instanceof Error ? error.message : String(error);
    }

    if (raw === null) {
      const result: InterpretationResult = {
        ...base,
        available: true,
        response: null,
        message:
          'The interpretation could not be generated because the model service could not be reached. ' +
          'Everything else on this page is computed by the analysis engine and is unaffected.',
        detail: transportError,
        gate: null,
        milliseconds: Date.now() - started,
      };
      this.audit(request, userPrompt, null, null, result);
      return result;
    }

    const verdict = validateResponse(raw, request.evidence, {
      numericTolerance: 0.02,
      numericFloor: 0,
      allowHypothesis: request.stage !== 'baseline',
    });

    const result: InterpretationResult = {
      ...base,
      available: true,
      response: verdict.accepted ? verdict.response : null,
      message: verdict.accepted
        ? verdict.response?.abstained
          ? verdict.response.abstentionReason ??
            'The model reported that the evidence does not support an interpretation of this run.'
          : ''
        : verdict.learnerMessage,
      detail: verdict.accepted ? null : verdict.rejections.map((r) => `${r.code}: ${r.detail}`).join(' | '),
      gate: { accepted: verdict.accepted, rejections: verdict.rejections },
      milliseconds: Date.now() - started,
    };

    this.audit(request, userPrompt, raw, verdict, result);
    return result;
  }

  // -- provider -------------------------------------------------------------

  /**
   * One request, to whichever provider is configured.
   *
   * An OpenAI-compatible gateway takes precedence when `SPATIAL_AI_BASE_URL` is
   * set, because that is how this estate routes model traffic through a single
   * audited egress point. The direct Gemini path exists for a deployment
   * without one.
   */
  private async call(system: string, user: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
    try {
      if (config.ai.baseUrl) {
        const response = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.ai.apiKey ? { authorization: `Bearer ${config.ai.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.ai.model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`gateway returned ${response.status}`);
        const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
        return body.choices?.[0]?.message?.content ?? null;
      }

      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.ai.model)}:generateContent` +
        `?key=${encodeURIComponent(config.ai.apiKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`provider returned ${response.status}`);
      const body = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return body.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  // -- rate limit -----------------------------------------------------------

  private allow(userId: string): boolean {
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const calls = (this.callsByUser.get(userId) ?? []).filter((at) => at > hourAgo);
    if (calls.length >= config.ai.rateLimitPerHour) {
      this.callsByUser.set(userId, calls);
      return false;
    }
    calls.push(now);
    this.callsByUser.set(userId, calls);
    return true;
  }

  // -- audit ----------------------------------------------------------------

  private audit(
    request: InterpretationRequest,
    prompt: string,
    raw: string | null,
    verdict: GateVerdict | null,
    result: InterpretationResult,
  ): void {
    try {
      appendFileSync(
        this.auditPath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          runId: request.runId,
          // The user id is recorded because §16.2 asks for an audit log; it is
          // never rendered to another user.
          userId: request.userId,
          stage: request.stage,
          model: config.ai.model,
          promptVersion: config.ai.promptVersion,
          policyVersion: config.ai.policyVersion,
          evidenceClaims: request.evidence.claims.length,
          promptBytes: prompt.length,
          response: raw,
          accepted: verdict?.accepted ?? false,
          rejections: verdict?.rejections ?? [],
          milliseconds: result.milliseconds,
        })}\n`,
      );
    } catch {
      // A failing audit sink must not fail the request; the interpretation is
      // already gated and the loss is one log line.
    }
  }
}
