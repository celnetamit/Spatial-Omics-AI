import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AGREEMENT_CONFIRMATION, AGREEMENT_SECTIONS, AGREEMENT_VERSION, REVIEW_ROLES,
  agreementFingerprint, missingAcknowledgementFields, type AcknowledgementForm,
} from '../lib/governance/reviewerAgreement';

/**
 * The agreement is org-wide, and this is the test that keeps it that way.
 *
 * Every Live Labs lab ships the same undertaking, and a reviewer signs it once.
 * If one lab's copy drifts — a reworded bullet, a dropped clause — then two
 * signatures recorded against the same version would mean different things, and
 * the version field would no longer tell anybody that.
 *
 * The fingerprint below is the shared value asserted in every sibling lab.
 * If it fails, the text changed: either restore it, or change it everywhere
 * and bump AGREEMENT_VERSION deliberately.
 */

const SHARED_FINGERPRINT = 'fnv1a-3d58a7d0-7254';

function form(over: Partial<AcknowledgementForm> = {}): AcknowledgementForm {
  return {
    labTitle: 'Spatial Omics AI Virtual LiveLab',
    domain: 'Spatial omics and perturbation modelling',
    reviewBuild: '1.0.0',
    reviewerName: 'A Reviewer',
    designation: 'Professor',
    institution: 'A University',
    email: 'reviewer@example.edu',
    dateAccessProvided: '2026-09-21',
    expectedCompletion: '',
    reviewRoles: ['TECHNICAL'],
    signature: 'A Reviewer',
    signedDate: '2026-09-21',
    confirmed: true,
    ...over,
  };
}

describe('the reviewer agreement', () => {
  it('matches the fingerprint every other lab carries', () => {
    expect(agreementFingerprint()).toBe(SHARED_FINGERPRINT);
  });

  it('is the version the estate is on', () => {
    expect(AGREEMENT_VERSION).toBe('nanoschool-reviewer-agreement-2026-09');
  });

  it('carries all ten sections of the issued document, in order', () => {
    expect(AGREEMENT_SECTIONS.map((s) => s.number)).toEqual(
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    );
    for (const section of AGREEMENT_SECTIONS) {
      expect(section.heading.length, section.number).toBeGreaterThan(0);
      expect(section.blocks.length, section.number).toBeGreaterThan(0);
    }
  });

  it('keeps the confirmation wording the reviewer ticks', () => {
    expect(AGREEMENT_CONFIRMATION).toContain('read and understood');
    expect(AGREEMENT_CONFIRMATION).toContain('confidential expert-review purpose');
  });

  it('is displayed in full by the screen, not summarised', () => {
    // A "read the full terms" link with a summary on screen would make the
    // acknowledgement consent to something nobody displayed.
    const screen = readFileSync('components/governance/ReviewerAgreement.tsx', 'utf8');
    expect(screen).toContain('AGREEMENT_SECTIONS.map');
    expect(screen).toContain('block.bullets');
    expect(screen).toContain('AGREEMENT_PREAMBLE.map');
  });

  it('offers every review role the document lists', () => {
    expect(REVIEW_ROLES.map((r) => r.id)).toEqual([
      'SCIENTIFIC', 'TECHNICAL', 'AI_COMPUTATIONAL', 'DATA_METHODOLOGY',
      'EDUCATIONAL_UX', 'SECURITY_PRIVACY', 'COMPLETE',
    ]);
  });
});

describe('the acknowledgement', () => {
  it('accepts a complete form', () => {
    expect(missingAcknowledgementFields(form())).toEqual([]);
  });

  it('needs the tick and the signature, which are not the same thing', () => {
    // One is assent to the text, the other is the reviewer putting their name
    // to it, and the document asks for both.
    expect(missingAcknowledgementFields(form({ confirmed: false }))).toContain(
      'Confirmation that you have read and understood the agreement',
    );
    expect(missingAcknowledgementFields(form({ signature: '  ' }))).toContain('Reviewer signature');
  });

  it('needs an institution, because the recognition clause turns on it', () => {
    expect(missingAcknowledgementFields(form({ institution: '' }))).toContain('Institution / organisation');
  });

  it('needs at least one review role', () => {
    expect(missingAcknowledgementFields(form({ reviewRoles: [] }))).toContain('At least one review role');
  });

  it('rejects an email that is not one', () => {
    expect(missingAcknowledgementFields(form({ email: 'not-an-email' }))).toContain('A valid email address');
  });
});
