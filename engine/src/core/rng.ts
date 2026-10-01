/**
 * Deterministic pseudo-random numbers, in named independent streams.
 *
 * §5.2 makes the seed part of the reproducibility manifest and §15.2 requires a
 * replayed run to reproduce its stochastic outputs within tolerance, so every
 * draw in this engine comes from here and nothing calls `Math.random`.
 *
 * The streams are the important part. A single sequence shared between, say,
 * the permutation test and the tissue generator couples them: change how many
 * cells you draw and the permutation p-values move, for no scientific reason at
 * all, and a "reproducibility" test that only ever runs one configuration will
 * never notice. `stream('neighbourhood-permutation')` derives an independent
 * generator from the run seed and a label, so adding a draw in one place cannot
 * shift the numbers in another.
 */

/** A 32-bit mix (splitmix32) used to derive stream seeds from a label. */
function mix32(x: number): number {
  let z = x | 0;
  z = (z + 0x9e3779b9) | 0;
  z ^= z >>> 16;
  z = Math.imul(z, 0x21f0aaad);
  z ^= z >>> 15;
  z = Math.imul(z, 0x735a2d97);
  z ^= z >>> 15;
  return z >>> 0;
}

function hashLabel(label: string): number {
  // FNV-1a over the label, so a stream name maps to a fixed offset.
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * xoshiro128** — small, fast, and with a far better low-bit distribution than
 * the `sin`-based one-liners that tend to appear in browser code. Four 32-bit
 * words of state, period 2^128-1.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let x = seed >>> 0;
    // Never start from an all-zero state; it is a fixed point.
    this.s0 = mix32((x = (x + 1) | 0)) || 1;
    this.s1 = mix32((x = (x + 1) | 0)) || 2;
    this.s2 = mix32((x = (x + 1) | 0)) || 3;
    this.s3 = mix32((x = (x + 1) | 0)) || 4;
  }

  /** Raw 32-bit draw. */
  nextUint32(): number {
    const scaled = Math.imul(this.s1, 5) >>> 0;
    const rotated = ((scaled << 7) | (scaled >>> 25)) >>> 0;
    const out = Math.imul(rotated, 9) >>> 0;

    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return out;
  }

  /** Uniform in [0, 1). 53-bit mantissa from two draws. */
  next(): number {
    const hi = this.nextUint32() >>> 5; // 27 bits
    const lo = this.nextUint32() >>> 6; // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  /** Uniform in [lo, hi). */
  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Standard normal, Box–Muller. The spare is kept rather than discarded. */
  private spare: number | null = null;
  normal(mean = 0, sd = 1): number {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return mean + sd * value;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * factor;
    return mean + sd * u * factor;
  }

  /** Log-normal with the given underlying normal parameters. */
  logNormal(mu: number, sigma: number): number {
    return Math.exp(this.normal(mu, sigma));
  }

  /**
   * Poisson draw. Knuth's method below 30, a normal approximation with
   * continuity correction above it — exact counting there would loop for
   * thousands of iterations per cell on a deep-sequenced gene.
   */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k += 1;
        p *= this.next();
      } while (p > limit);
      return k - 1;
    }
    return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
  }

  /**
   * Negative binomial with mean `mu` and dispersion `theta` (variance
   * mu + mu^2/theta) — the standard model for UMI counts, and the reason a
   * plain Poisson tissue would look implausibly clean to anyone who has seen
   * real data.
   */
  negativeBinomial(mu: number, theta: number): number {
    if (mu <= 0) return 0;
    if (!Number.isFinite(theta) || theta <= 0) return this.poisson(mu);
    return this.poisson(mu * this.gamma(theta, 1 / theta));
  }

  /** Gamma(shape, scale), Marsaglia–Tsang. */
  gamma(shape: number, scale: number): number {
    if (shape < 1) {
      const u = this.next();
      return this.gamma(shape + 1, scale) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = this.normal();
      const v = Math.pow(1 + c * x, 3);
      if (v <= 0) continue;
      const u = this.next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const a = items[i] as T;
      items[i] = items[j] as T;
      items[j] = a;
    }
    return items;
  }

  /** A permutation of 0..n-1. */
  permutation(n: number): Int32Array {
    const out = new Int32Array(n);
    for (let i = 0; i < n; i += 1) out[i] = i;
    for (let i = n - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const a = out[i] as number;
      out[i] = out[j] as number;
      out[j] = a;
    }
    return out;
  }

  /** `k` distinct indices from 0..n-1, without building the full permutation. */
  sampleIndices(n: number, k: number): number[] {
    if (k >= n) {
      const all: number[] = [];
      for (let i = 0; i < n; i += 1) all.push(i);
      return this.shuffle(all);
    }
    const chosen = new Set<number>();
    while (chosen.size < k) chosen.add(this.int(n));
    return [...chosen].sort((a, b) => a - b);
  }
}

/**
 * The run's random state: one seed, many independent streams.
 *
 * Every consumer names what it is drawing for. Two calls with the same name in
 * the same run get the same sequence, which is what makes a replay reproduce —
 * and two different names never interfere, which is what stops an unrelated
 * change from moving a p-value.
 */
export class RandomState {
  readonly seed: number;
  private readonly cache = new Map<string, Rng>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** The generator for a named purpose, created on first use. */
  stream(label: string): Rng {
    const existing = this.cache.get(label);
    if (existing) return existing;
    const created = new Rng((this.seed ^ hashLabel(label)) >>> 0);
    this.cache.set(label, created);
    return created;
  }

  /** A fresh generator for a named purpose, ignoring any cached one. */
  fresh(label: string): Rng {
    return new Rng((this.seed ^ hashLabel(label)) >>> 0);
  }

  /** A sub-state, for a phase that wants its own family of streams. */
  derive(label: string): RandomState {
    return new RandomState((this.seed ^ hashLabel(label)) >>> 0);
  }
}
