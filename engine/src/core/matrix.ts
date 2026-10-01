/**
 * Dense and sparse matrices, and the decompositions the pipeline needs.
 *
 * Row-major `Float64Array` throughout: an expression matrix is read by cell far
 * more often than by feature, and a row slice that is a contiguous view is the
 * difference between a neighbourhood query that feels instant and one that does
 * not.
 *
 * The PCA here is a randomised block power iteration rather than a full
 * eigendecomposition. On a 3000 x 400 matrix the top 30 components are what the
 * pipeline uses and the remaining 370 are discarded, so computing them would be
 * most of the cost for none of the result.
 */

import type { Rng } from './rng';

export class Matrix {
  readonly rows: number;
  readonly cols: number;
  readonly values: Float64Array;

  constructor(rows: number, cols: number, values?: Float64Array) {
    this.rows = rows;
    this.cols = cols;
    this.values = values ?? new Float64Array(rows * cols);
    if (this.values.length !== rows * cols) {
      throw new Error(`Matrix ${rows}x${cols} needs ${rows * cols} values, got ${this.values.length}`);
    }
  }

  static zeros(rows: number, cols: number): Matrix {
    return new Matrix(rows, cols);
  }

  static from(rows: number[][]): Matrix {
    const r = rows.length;
    const c = r > 0 ? (rows[0] as number[]).length : 0;
    const m = new Matrix(r, c);
    for (let i = 0; i < r; i += 1) {
      const row = rows[i] as number[];
      if (row.length !== c) throw new Error(`Ragged matrix at row ${i}`);
      for (let j = 0; j < c; j += 1) m.values[i * c + j] = row[j] as number;
    }
    return m;
  }

  get(row: number, col: number): number {
    return this.values[row * this.cols + col] as number;
  }

  set(row: number, col: number, value: number): void {
    this.values[row * this.cols + col] = value;
  }

  /** A live view of one row. Writing to it writes to the matrix. */
  row(index: number): Float64Array {
    return this.values.subarray(index * this.cols, (index + 1) * this.cols);
  }

  /** A copy of one column; columns are strided, so this cannot be a view. */
  column(index: number): Float64Array {
    const out = new Float64Array(this.rows);
    for (let i = 0; i < this.rows; i += 1) out[i] = this.values[i * this.cols + index] as number;
    return out;
  }

  clone(): Matrix {
    return new Matrix(this.rows, this.cols, Float64Array.from(this.values));
  }

  /** Rows selected by index, in the order given. */
  selectRows(indices: ArrayLike<number>): Matrix {
    const out = new Matrix(indices.length, this.cols);
    for (let i = 0; i < indices.length; i += 1) {
      out.values.set(this.row(indices[i] as number), i * this.cols);
    }
    return out;
  }

  selectColumns(indices: ArrayLike<number>): Matrix {
    const out = new Matrix(this.rows, indices.length);
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < indices.length; j += 1) {
        out.values[i * indices.length + j] = this.get(i, indices[j] as number);
      }
    }
    return out;
  }

  columnMeans(): Float64Array {
    const out = new Float64Array(this.cols);
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1) out[j] = (out[j] as number) + this.get(i, j);
    }
    if (this.rows > 0) for (let j = 0; j < this.cols; j += 1) out[j] = (out[j] as number) / this.rows;
    return out;
  }

  columnVariances(means?: Float64Array): Float64Array {
    const mu = means ?? this.columnMeans();
    const out = new Float64Array(this.cols);
    if (this.rows < 2) return out.fill(Number.NaN);
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1) {
        const d = this.get(i, j) - (mu[j] as number);
        out[j] = (out[j] as number) + d * d;
      }
    }
    for (let j = 0; j < this.cols; j += 1) out[j] = (out[j] as number) / (this.rows - 1);
    return out;
  }

  /** Subtracts the column means in place and returns them. */
  centreColumns(): Float64Array {
    const mu = this.columnMeans();
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1) {
        this.values[i * this.cols + j] = this.get(i, j) - (mu[j] as number);
      }
    }
    return mu;
  }

  map(fn: (value: number, row: number, col: number) => number): Matrix {
    const out = new Matrix(this.rows, this.cols);
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1) out.values[i * this.cols + j] = fn(this.get(i, j), i, j);
    }
    return out;
  }

  /** this (n x k) times other (k x m). */
  multiply(other: Matrix): Matrix {
    if (this.cols !== other.rows) {
      throw new Error(`Cannot multiply ${this.rows}x${this.cols} by ${other.rows}x${other.cols}`);
    }
    const out = new Matrix(this.rows, other.cols);
    for (let i = 0; i < this.rows; i += 1) {
      for (let k = 0; k < this.cols; k += 1) {
        const a = this.get(i, k);
        if (a === 0) continue;
        const offsetB = k * other.cols;
        const offsetOut = i * other.cols;
        for (let j = 0; j < other.cols; j += 1) {
          out.values[offsetOut + j] = (out.values[offsetOut + j] as number) + a * (other.values[offsetB + j] as number);
        }
      }
    }
    return out;
  }

  transpose(): Matrix {
    const out = new Matrix(this.cols, this.rows);
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1) out.values[j * this.rows + i] = this.get(i, j);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Sparse rows — how an expression matrix actually arrives
// ---------------------------------------------------------------------------

/** Compressed sparse row, the layout an AnnData `X` usually comes in. */
export interface SparseRows {
  rows: number;
  cols: number;
  /** Length rows+1; `indptr[i]` is where row i starts. */
  indptr: Int32Array;
  indices: Int32Array;
  data: Float64Array;
}

export function sparseToDense(sparse: SparseRows): Matrix {
  const out = new Matrix(sparse.rows, sparse.cols);
  for (let i = 0; i < sparse.rows; i += 1) {
    const start = sparse.indptr[i] as number;
    const end = sparse.indptr[i + 1] as number;
    for (let k = start; k < end; k += 1) {
      out.values[i * sparse.cols + (sparse.indices[k] as number)] = sparse.data[k] as number;
    }
  }
  return out;
}

export function denseToSparse(matrix: Matrix, threshold = 0): SparseRows {
  const indptr = new Int32Array(matrix.rows + 1);
  const indices: number[] = [];
  const data: number[] = [];
  for (let i = 0; i < matrix.rows; i += 1) {
    indptr[i] = indices.length;
    for (let j = 0; j < matrix.cols; j += 1) {
      const value = matrix.get(i, j);
      if (Math.abs(value) > threshold) {
        indices.push(j);
        data.push(value);
      }
    }
  }
  indptr[matrix.rows] = indices.length;
  return {
    rows: matrix.rows,
    cols: matrix.cols,
    indptr,
    indices: Int32Array.from(indices),
    data: Float64Array.from(data),
  };
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

export interface PcaResult {
  /** n x k scores. */
  scores: Matrix;
  /** k x p loadings, rows are components. */
  components: Matrix;
  /** Variance explained by each component. */
  explainedVariance: Float64Array;
  /** As a fraction of the total variance in the centred input. */
  explainedVarianceRatio: Float64Array;
  /** Column means removed before decomposition, kept so it can be undone. */
  centre: Float64Array;
}

/** Modified Gram–Schmidt, twice, because once is not numerically enough. */
function orthonormalise(block: Matrix): void {
  for (let pass = 0; pass < 2; pass += 1) {
    for (let j = 0; j < block.cols; j += 1) {
      for (let k = 0; k < j; k += 1) {
        let dot = 0;
        for (let i = 0; i < block.rows; i += 1) dot += block.get(i, j) * block.get(i, k);
        for (let i = 0; i < block.rows; i += 1) {
          block.set(i, j, block.get(i, j) - dot * block.get(i, k));
        }
      }
      let norm = 0;
      for (let i = 0; i < block.rows; i += 1) norm += block.get(i, j) * block.get(i, j);
      norm = Math.sqrt(norm);
      if (norm > 1e-12) {
        for (let i = 0; i < block.rows; i += 1) block.set(i, j, block.get(i, j) / norm);
      }
    }
  }
}

/**
 * Principal components by randomised block power iteration.
 *
 * `matrix` is not modified. The result is deterministic given the generator,
 * which is what lets §16.1 record a seed and mean it.
 */
export function pca(matrix: Matrix, components: number, rng: Rng, iterations = 7): PcaResult {
  const n = matrix.rows;
  const p = matrix.cols;
  const k = Math.min(components, Math.min(n, p));

  const centred = matrix.clone();
  const centre = centred.centreColumns();

  // Oversample: the extra columns absorb the error that would otherwise land on
  // the last component we keep.
  const oversample = Math.min(p, k + 10);
  let block = new Matrix(p, oversample);
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j < oversample; j += 1) block.set(i, j, rng.normal());
  }
  orthonormalise(block);

  const transposed = centred.transpose();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const projected = centred.multiply(block); // n x oversample
    const back = transposed.multiply(projected); // p x oversample
    orthonormalise(back);
    block = back;
  }

  // Small eigenproblem on the projected covariance.
  const projected = centred.multiply(block); // n x oversample
  const small = projected.transpose().multiply(projected); // oversample x oversample
  const eigen = symmetricEigen(small);

  const scores = new Matrix(n, k);
  const loadings = new Matrix(k, p);
  const explainedVariance = new Float64Array(k);

  for (let c = 0; c < k; c += 1) {
    const vector = eigen.vectors.column(c);
    for (let i = 0; i < n; i += 1) {
      let value = 0;
      for (let j = 0; j < oversample; j += 1) value += projected.get(i, j) * (vector[j] as number);
      scores.set(i, c, value);
    }
    for (let j = 0; j < p; j += 1) {
      let value = 0;
      for (let q = 0; q < oversample; q += 1) value += block.get(j, q) * (vector[q] as number);
      loadings.set(c, j, value);
    }
    explainedVariance[c] = n > 1 ? (eigen.values[c] as number) / (n - 1) : 0;
  }

  const totalVariance = centred.columnVariances(new Float64Array(p)).reduce((a, b) => a + b, 0);
  const explainedVarianceRatio = new Float64Array(k);
  for (let c = 0; c < k; c += 1) {
    explainedVarianceRatio[c] = totalVariance > 0 ? (explainedVariance[c] as number) / totalVariance : 0;
  }

  return { scores, components: loadings, explainedVariance, explainedVarianceRatio, centre };
}

export interface EigenResult {
  /** Descending. */
  values: Float64Array;
  /** Columns are eigenvectors, matching `values`. */
  vectors: Matrix;
}

/**
 * Cyclic Jacobi eigendecomposition for a small symmetric matrix.
 *
 * Only ever called on the `oversample x oversample` projection above (tens of
 * rows), where its O(n^3) per sweep is irrelevant and its accuracy is not.
 */
export function symmetricEigen(input: Matrix, maxSweeps = 60): EigenResult {
  const n = input.rows;
  if (n !== input.cols) throw new Error('symmetricEigen needs a square matrix');
  const a = input.clone();
  const v = new Matrix(n, n);
  for (let i = 0; i < n; i += 1) v.set(i, i, 1);

  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) off += a.get(i, j) * a.get(i, j);
    }
    if (Math.sqrt(off) < 1e-12) break;

    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = a.get(p, q);
        if (Math.abs(apq) < 1e-15) continue;
        const theta = (a.get(q, q) - a.get(p, p)) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let i = 0; i < n; i += 1) {
          const aip = a.get(i, p);
          const aiq = a.get(i, q);
          a.set(i, p, c * aip - s * aiq);
          a.set(i, q, s * aip + c * aiq);
        }
        for (let i = 0; i < n; i += 1) {
          const api = a.get(p, i);
          const aqi = a.get(q, i);
          a.set(p, i, c * api - s * aqi);
          a.set(q, i, s * api + c * aqi);
        }
        for (let i = 0; i < n; i += 1) {
          const vip = v.get(i, p);
          const viq = v.get(i, q);
          v.set(i, p, c * vip - s * viq);
          v.set(i, q, s * vip + c * viq);
        }
      }
    }
  }

  const pairs = Array.from({ length: n }, (_, i) => ({ value: a.get(i, i), index: i }));
  pairs.sort((x, y) => y.value - x.value);

  const values = new Float64Array(n);
  const vectors = new Matrix(n, n);
  for (let c = 0; c < n; c += 1) {
    const pair = pairs[c] as { value: number; index: number };
    values[c] = pair.value;
    for (let i = 0; i < n; i += 1) vectors.set(i, c, v.get(i, pair.index));
  }
  return { values, vectors };
}

/** Ridge-regularised least squares, used by the linear propagation baseline. */
export function ridgeSolve(x: Matrix, y: Float64Array, lambda: number): Float64Array {
  const p = x.cols;
  const xtx = new Matrix(p, p);
  const xty = new Float64Array(p);

  for (let i = 0; i < x.rows; i += 1) {
    const row = x.row(i);
    const target = y[i] as number;
    for (let a = 0; a < p; a += 1) {
      const va = row[a] as number;
      if (va === 0) continue;
      xty[a] = (xty[a] as number) + va * target;
      for (let b = a; b < p; b += 1) {
        xtx.set(a, b, xtx.get(a, b) + va * (row[b] as number));
      }
    }
  }
  for (let a = 0; a < p; a += 1) {
    xtx.set(a, a, xtx.get(a, a) + lambda);
    for (let b = a + 1; b < p; b += 1) xtx.set(b, a, xtx.get(a, b));
  }
  return choleskySolve(xtx, xty);
}

/** Cholesky with a diagonal bump if the matrix is not quite positive definite. */
export function choleskySolve(a: Matrix, b: Float64Array): Float64Array {
  const n = a.rows;
  const l = new Matrix(n, n);
  const work = a.clone();

  for (let jitterAttempt = 0; jitterAttempt < 8; jitterAttempt += 1) {
    let ok = true;
    l.values.fill(0);
    for (let i = 0; i < n && ok; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        let total = work.get(i, j);
        for (let k = 0; k < j; k += 1) total -= l.get(i, k) * l.get(j, k);
        if (i === j) {
          if (total <= 1e-12) {
            ok = false;
            break;
          }
          l.set(i, j, Math.sqrt(total));
        } else {
          l.set(i, j, total / l.get(j, j));
        }
      }
    }
    if (ok) break;
    const bump = Math.pow(10, jitterAttempt - 6);
    for (let i = 0; i < n; i += 1) work.set(i, i, work.get(i, i) + bump);
  }

  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let total = b[i] as number;
    for (let k = 0; k < i; k += 1) total -= l.get(i, k) * (y[k] as number);
    const pivot = l.get(i, i);
    y[i] = pivot > 0 ? total / pivot : 0;
  }
  const out = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let total = y[i] as number;
    for (let k = i + 1; k < n; k += 1) total -= l.get(k, i) * (out[k] as number);
    const pivot = l.get(i, i);
    out[i] = pivot > 0 ? total / pivot : 0;
  }
  return out;
}

/** Euclidean distance between two rows of (possibly different) matrices. */
export function euclidean(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let total = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    total += d * d;
  }
  return Math.sqrt(total);
}
