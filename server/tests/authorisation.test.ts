/**
 * The role and capability model, and the tier gate.
 *
 * Roles are enforced in one module so a new route cannot ship without a check —
 * the default, when no requirement is stated, is to refuse. These tests assert
 * the defaults rather than the happy paths, because the happy paths are what
 * everybody exercises by hand.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeWithHub, can, canOpenMode, developmentIdentity, issueSessionToken, modeLock, participantPseudonym,
  readSessionToken, type Capability, type Identity,
} from '../src/auth';
import { config } from '../src/config';

function identity(over: Partial<Identity> = {}): Identity {
  return {
    userId: 'u1',
    displayName: 'Test',
    email: null,
    roles: ['learner'],
    tier: 'basic',
    isReviewer: false,
    researchConsent: false,
    ...over,
  };
}

describe('capabilities', () => {
  it('lets a learner run the science', () => {
    const learner = identity();
    for (const capability of ['open-project', 'run-analysis', 'run-prediction', 'run-rescue'] as Capability[]) {
      expect(can(learner, capability), capability).toBe(true);
    }
  });

  it('does not let a learner export research data or administer', () => {
    const learner = identity();
    expect(can(learner, 'export-research')).toBe(false);
    expect(can(learner, 'administer')).toBe(false);
    expect(can(learner, 'export-machine-readable')).toBe(false);
    expect(can(learner, 'view-provenance')).toBe(false);
  });

  it('refuses a capability nobody declared rather than allowing it', () => {
    // The default has to be refusal: a route naming a capability that was never
    // added to the table must fail closed.
    expect(can(identity({ roles: ['admin'] }), 'not-a-capability' as Capability)).toBe(false);
  });

  it('gives a researcher the research export and nothing else extra', () => {
    const researcher = identity({ roles: ['learner', 'researcher'] });
    expect(can(researcher, 'export-research')).toBe(true);
    expect(can(researcher, 'administer')).toBe(false);
  });
});

describe('the tier gate', () => {
  it('opens only the tiers a learner has paid for', () => {
    const basic = identity({ tier: 'basic' });
    expect(canOpenMode(basic, 'basic')).toBe(true);
    expect(canOpenMode(basic, 'moderate')).toBe(false);
    expect(canOpenMode(basic, 'expert')).toBe(false);

    const moderate = identity({ tier: 'moderate' });
    expect(canOpenMode(moderate, 'moderate')).toBe(true);
    expect(canOpenMode(moderate, 'expert')).toBe(false);
  });

  it('exempts a reviewer whatever their tier', () => {
    // A reviewer has to be able to open the mode they are reviewing, and the
    // exemption lives in the lab rather than on the hub for that reason.
    const reviewer = identity({ tier: 'basic', isReviewer: true, roles: ['learner', 'reviewer'] });
    expect(canOpenMode(reviewer, 'expert')).toBe(true);
  });

  it('exempts an administrator and an instructor', () => {
    expect(canOpenMode(identity({ roles: ['learner', 'admin'] }), 'expert')).toBe(true);
    expect(canOpenMode(identity({ roles: ['learner', 'instructor'] }), 'expert')).toBe(true);
  });

  it('opens Intermediate after a first completed experiment, and nothing beyond it', () => {
    const learner = identity({ tier: 'basic' });
    expect(canOpenMode(learner, 'moderate', { completedExperiment: false })).toBe(false);
    expect(modeLock(learner, 'moderate', { completedExperiment: false })).toMatch(/first completed experiment/);
    expect(canOpenMode(learner, 'moderate', { completedExperiment: true })).toBe(true);
    // Progress opens Intermediate only; Advanced stays with role or tier.
    expect(canOpenMode(learner, 'expert', { completedExperiment: true })).toBe(false);
    expect(modeLock(learner, 'expert', { completedExperiment: true })).toMatch(/administrators and reviewers/);
  });
});

describe('the identity the hub returns', () => {
  afterEach(() => vi.unstubAllGlobals());

  // authorize-lab sends one `role` string, not a `roles` array.
  function hubSays(user: Record<string, unknown>): void {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ authorized: true, sessionToken: 'hub-session', user: { id: 'hub-1', name: 'Hub user', email: 'u@example.org', ...user } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
  }

  it.skipIf(!config.auth.enabled)('makes a hub super admin an administrator, with every mode open', async () => {
    hubSays({ role: 'SUPER_ADMIN', isReviewer: false });
    const result = await authorizeWithHub('launch-token');
    expect(result.identity?.roles).toContain('admin');
    expect(canOpenMode(result.identity as Identity, 'expert')).toBe(true);
  });

  it.skipIf(!config.auth.enabled)('keeps a hub user a learner who starts in Beginner', async () => {
    hubSays({ role: 'USER', isReviewer: false });
    const result = await authorizeWithHub('launch-token');
    expect(result.identity?.roles).toEqual(['learner']);
    expect(canOpenMode(result.identity as Identity, 'basic')).toBe(true);
    expect(canOpenMode(result.identity as Identity, 'moderate')).toBe(false);
  });
});

describe('session tokens', () => {
  it('round-trips a valid token', () => {
    const expiry = Date.now() + 60_000;
    const payload = readSessionToken(issueSessionToken('session-1', expiry));
    expect(payload?.sid).toBe('session-1');
    expect(payload?.exp).toBe(expiry);
  });

  it('refuses a tampered payload', () => {
    const token = issueSessionToken('session-1', Date.now() + 60_000);
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sid: 'session-2', exp: Date.now() + 60_000 })).toString('base64url');
    expect(readSessionToken(`${forged}.${signature}`)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it('refuses a tampered signature', () => {
    const token = issueSessionToken('session-1', Date.now() + 60_000);
    expect(readSessionToken(`${token.split('.')[0]}.notasignature`)).toBeNull();
  });

  it('refuses an expired token', () => {
    expect(readSessionToken(issueSessionToken('session-1', Date.now() - 1))).toBeNull();
  });

  it('refuses malformed input without throwing', () => {
    for (const bad of ['', 'no-dot', 'a.b.c', '...', 'eyJ.x']) {
      expect(readSessionToken(bad)).toBeNull();
    }
  });
});

describe('the development identity', () => {
  it('is a plain learner by default', () => {
    const dev = developmentIdentity('');
    expect(dev.roles).toEqual(['learner']);
    expect(dev.tier).toBe('basic');
  });

  it('elevates only to a role that exists', () => {
    expect(developmentIdentity('admin').roles).toContain('admin');
    expect(developmentIdentity('wizard').roles).toEqual(['learner']);
  });
});

describe('the research pseudonym', () => {
  it('is stable for a user and different between users', () => {
    expect(participantPseudonym('u1')).toBe(participantPseudonym('u1'));
    expect(participantPseudonym('u1')).not.toBe(participantPseudonym('u2'));
  });

  it('does not contain the user id', () => {
    expect(participantPseudonym('user-secret-1234')).not.toContain('user-secret');
  });
});
