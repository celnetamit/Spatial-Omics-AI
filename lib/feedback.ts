/**
 * Feedback sent from inside the lab to the portal's admin centre.
 *
 * The same form as the other labs (FraudShield, MicrobeAI): the portal's
 * `/api/labs/feedback` requires a name, an email and a designation, and
 * accepts a category, an optional 1-5 rating, the message and the screen it
 * came from. This lab used to send only a category of its own and a message,
 * so the portal refused every submission ("These are required: name, email,
 * designation").
 *
 * The name and email asked for here are not the signed-in account. They are
 * what the sender says about themselves, stored alongside the account the
 * portal records it against: labs run on shared machines and in taught
 * sessions, and a reply address can legitimately differ from the registration
 * one. The draft lives in sessionStorage, keyed to the signed-in user, so a
 * half-written message with someone's name and email does not outlive the
 * browser session on a shared machine.
 */

import { api, ApiError } from './api';
import { appConfig } from './config';

export type FeedbackCategory = 'GENERAL' | 'BUG' | 'SCIENCE' | 'USABILITY' | 'FEATURE';

export const FEEDBACK_CATEGORIES: { value: FeedbackCategory; label: string; hint: string }[] = [
  { value: 'GENERAL', label: 'General', hint: 'Anything that does not fit the others.' },
  { value: 'BUG', label: 'Something is broken', hint: 'A control that does nothing, a number that looks wrong, a screen that fails.' },
  { value: 'SCIENCE', label: 'Method or accuracy', hint: 'A result you disagree with, or a modelling choice you would have made differently.' },
  { value: 'USABILITY', label: 'Hard to use or unclear', hint: 'Wording that confused you, a step you could not find.' },
  { value: 'FEATURE', label: 'Something missing', hint: 'What you needed the lab to do and it did not.' },
];

export interface FeedbackDraft {
  name: string;
  email: string;
  designation: string;
  category: FeedbackCategory;
  /** 0 means "not given"; a rating is optional and never invented. */
  rating: number;
  message: string;
}

export const EMPTY_DRAFT: FeedbackDraft = { name: '', email: '', designation: '', category: 'GENERAL', rating: 0, message: '' };
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_FIELD_LENGTH = 200;

export type FeedbackErrors = Partial<Record<keyof FeedbackDraft, string>>;

/** A shape check on the email and nothing stricter: strict patterns mostly turn away real addresses. */
export function validateFeedback(draft: FeedbackDraft): FeedbackErrors {
  const errors: FeedbackErrors = {};
  if (!draft.name.trim()) errors.name = 'Please give a name we can address a reply to.';
  if (!draft.email.trim()) errors.email = 'An email address is needed to reply.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) errors.email = 'That does not look like an email address.';
  if (!draft.designation.trim()) errors.designation = 'Your role or job title. It decides how your feedback is read.';
  if (!draft.message.trim()) errors.message = 'There is nothing to send yet.';
  else if (draft.message.trim().length < 10) errors.message = 'A few more words would make this actionable.';
  return errors;
}

const draftKey = (userId: string): string => `spatial.feedback.draft.v1:${userId}`;

export function loadDraft(userId: string): FeedbackDraft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FeedbackDraft>;
    return {
      ...EMPTY_DRAFT,
      ...parsed,
      category: FEEDBACK_CATEGORIES.some((entry) => entry.value === parsed.category) ? (parsed.category as FeedbackCategory) : 'GENERAL',
    };
  } catch {
    return null;
  }
}

export function saveDraft(userId: string, draft: FeedbackDraft): void {
  try {
    const empty = !draft.name && !draft.email && !draft.designation && !draft.message;
    if (empty) sessionStorage.removeItem(draftKey(userId));
    else sessionStorage.setItem(draftKey(userId), JSON.stringify(draft));
  } catch {
    // Private browsing: the draft is simply not kept across a reload.
  }
}

export function clearDraft(userId: string): void {
  try {
    sessionStorage.removeItem(draftKey(userId));
  } catch {
    // Nothing to clear.
  }
}

export type FeedbackResult =
  | { ok: true; id: string; receivedAt: string; note: string; signedInAs: string | null }
  | { ok: false; message: string };

/**
 * Send it, and say honestly when it did not go. Someone who wrote a
 * considered report and sees "thank you" when nothing was sent will not
 * write a second one; every failure keeps the draft and says why.
 */
export async function sendFeedback(draft: FeedbackDraft, screen: string): Promise<FeedbackResult> {
  try {
    const body = (await api.sendFeedback({
      name: draft.name.trim(),
      email: draft.email.trim(),
      designation: draft.designation.trim(),
      category: draft.category,
      ...(draft.rating > 0 ? { rating: draft.rating } : {}),
      message: draft.message.trim(),
      screen,
      appVersion: appConfig.version,
    })) as Record<string, unknown> | null;
    return {
      ok: true,
      id: typeof body?.id === 'string' ? body.id : 'recorded',
      receivedAt: typeof body?.receivedAt === 'string' ? body.receivedAt : new Date().toISOString(),
      note: typeof body?.note === 'string' ? body.note : 'Stored for the team to read. No automatic reply is sent.',
      signedInAs: typeof body?.signedInAs === 'string' ? body.signedInAs : null,
    };
  } catch (caught) {
    return {
      ok: false,
      message:
        caught instanceof ApiError
          ? `${caught.message}${caught.suggestedAction ? ` ${caught.suggestedAction}` : ''} Your draft is kept.`
          : 'Could not reach the lab server. Nothing was sent; your draft is kept.',
    };
  }
}
