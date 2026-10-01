/**
 * The mechanistic tissue model: a curated intracellular network plus the
 * secreted signals that couple cells to their neighbours.
 *
 * WHAT THIS IS, PRECISELY
 *
 * This is the data-generating process for the bundled demonstration case, and
 * the reference the spatial predictive model is trained against and measured
 * on. It is a mechanistic simulator, not a dataset: the topology below is
 * hand-curated from canonical, textbook signalling relationships, and the edge
 * weights are chosen to produce a tissue with realistic structure — they are
 * not fitted to measurements.
 *
 * So a metric computed against it means "the model recovers the propagation
 * behaviour of this mechanism", and that is the only thing it means. It is not
 * evidence about human tissue, and every screen and report that shows a number
 * derived from it says so. §1.4 puts a universal model out of scope and §14
 * demands held-out validation; this gives a held-out set with a known answer,
 * which is what makes ablations and leakage controls checkable at all.
 *
 * The alternative — training on real perturbation data — is the right thing for
 * a research-grade release and is named in §18.1 as a freeze item. It needs a
 * licensed spatial perturbation corpus that this build does not ship.
 */

/** A node in the intracellular network: a gene with a regulatory role. */
export interface NetworkNode {
  symbol: string;
  /** Broad pathway membership, for the pathway layer and for grouping. */
  pathway: string;
  /**
   * What the node does mechanistically.
   * `receptor` nodes read the extracellular ligand field; `ligand` nodes write
   * to it; `tf` nodes drive downstream expression; `effector` nodes are read
   * out as phenotype.
   */
  role: 'receptor' | 'ligand' | 'kinase' | 'tf' | 'effector' | 'structural';
  /** Basal activity in the absence of any input, in [0, 1]. */
  basal: number;
  /**
   * How fast the node relaxes toward its input. Slower nodes integrate their
   * neighbourhood over more of the propagation, which is what makes stage
   * structure emerge rather than everything settling in one step.
   */
  tau: number;
  uniprot?: string;
}

/** A directed regulatory edge, with a sign. */
export interface NetworkEdge {
  from: string;
  to: string;
  /** Positive activates, negative represses. */
  weight: number;
  /** A one-line justification, so the register can be audited. */
  basis: string;
}

/** A secreted signal: produced by a ligand node, read by a receptor node. */
export interface SecretedSignal {
  ligand: string;
  receptor: string;
  /**
   * Diffusion length in µm. Sets how far a perturbation propagates before the
   * field falls off, and is therefore the single most consequential number in
   * this file.
   */
  diffusionLength: number;
  /** Strength of the receptor's response to a unit of ligand. */
  potency: number;
  pathway: string;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/**
 * Sixty-four transcripts across eight pathway modules.
 *
 * Chosen so the modules are ones a drug or a knockout can plausibly be aimed
 * at, and so each has both a readout and something upstream of it: a panel of
 * pure markers would give a tissue that looks right and cannot be perturbed.
 */
export const NETWORK_NODES: NetworkNode[] = [
  // --- EGFR / MAPK -------------------------------------------------------
  { symbol: 'EGFR', pathway: 'EGFR-MAPK', role: 'receptor', basal: 0.25, tau: 0.5, uniprot: 'P00533' },
  { symbol: 'EGF', pathway: 'EGFR-MAPK', role: 'ligand', basal: 0.1, tau: 0.6 },
  { symbol: 'TGFA', pathway: 'EGFR-MAPK', role: 'ligand', basal: 0.08, tau: 0.6 },
  { symbol: 'GRB2', pathway: 'EGFR-MAPK', role: 'kinase', basal: 0.3, tau: 0.4 },
  { symbol: 'KRAS', pathway: 'EGFR-MAPK', role: 'kinase', basal: 0.2, tau: 0.45, uniprot: 'P01116' },
  { symbol: 'BRAF', pathway: 'EGFR-MAPK', role: 'kinase', basal: 0.15, tau: 0.45, uniprot: 'P15056' },
  { symbol: 'MAP2K1', pathway: 'EGFR-MAPK', role: 'kinase', basal: 0.18, tau: 0.4, uniprot: 'Q02750' },
  { symbol: 'MAPK1', pathway: 'EGFR-MAPK', role: 'kinase', basal: 0.2, tau: 0.35, uniprot: 'P28482' },
  { symbol: 'FOS', pathway: 'EGFR-MAPK', role: 'tf', basal: 0.1, tau: 0.25 },
  { symbol: 'JUN', pathway: 'EGFR-MAPK', role: 'tf', basal: 0.12, tau: 0.25 },
  { symbol: 'DUSP6', pathway: 'EGFR-MAPK', role: 'effector', basal: 0.1, tau: 0.3 },
  { symbol: 'SPRY2', pathway: 'EGFR-MAPK', role: 'effector', basal: 0.1, tau: 0.3 },

  // --- PI3K / AKT / mTOR --------------------------------------------------
  { symbol: 'PIK3CA', pathway: 'PI3K-AKT', role: 'kinase', basal: 0.2, tau: 0.45, uniprot: 'P42336' },
  { symbol: 'PTEN', pathway: 'PI3K-AKT', role: 'effector', basal: 0.4, tau: 0.6, uniprot: 'P60484' },
  { symbol: 'AKT1', pathway: 'PI3K-AKT', role: 'kinase', basal: 0.22, tau: 0.4, uniprot: 'P31749' },
  { symbol: 'MTOR', pathway: 'PI3K-AKT', role: 'kinase', basal: 0.2, tau: 0.5, uniprot: 'P42345' },
  { symbol: 'RPS6KB1', pathway: 'PI3K-AKT', role: 'effector', basal: 0.15, tau: 0.35 },
  { symbol: 'EIF4EBP1', pathway: 'PI3K-AKT', role: 'effector', basal: 0.3, tau: 0.35 },

  // --- Hypoxia ------------------------------------------------------------
  { symbol: 'HIF1A', pathway: 'Hypoxia', role: 'tf', basal: 0.15, tau: 0.5, uniprot: 'Q16665' },
  { symbol: 'VEGFA', pathway: 'Hypoxia', role: 'ligand', basal: 0.1, tau: 0.5, uniprot: 'P15692' },
  { symbol: 'KDR', pathway: 'Hypoxia', role: 'receptor', basal: 0.08, tau: 0.5, uniprot: 'P35968' },
  { symbol: 'SLC2A1', pathway: 'Hypoxia', role: 'effector', basal: 0.2, tau: 0.4 },
  { symbol: 'CA9', pathway: 'Hypoxia', role: 'effector', basal: 0.05, tau: 0.4 },
  { symbol: 'LDHA', pathway: 'Hypoxia', role: 'effector', basal: 0.3, tau: 0.35 },
  { symbol: 'PGK1', pathway: 'Hypoxia', role: 'effector', basal: 0.3, tau: 0.35 },

  // --- TGF-beta / EMT -----------------------------------------------------
  { symbol: 'TGFB1', pathway: 'TGFB-EMT', role: 'ligand', basal: 0.15, tau: 0.6, uniprot: 'P01137' },
  { symbol: 'TGFBR1', pathway: 'TGFB-EMT', role: 'receptor', basal: 0.25, tau: 0.5, uniprot: 'P36897' },
  { symbol: 'TGFBR2', pathway: 'TGFB-EMT', role: 'receptor', basal: 0.25, tau: 0.5, uniprot: 'P37173' },
  { symbol: 'SMAD2', pathway: 'TGFB-EMT', role: 'tf', basal: 0.2, tau: 0.4 },
  { symbol: 'SMAD3', pathway: 'TGFB-EMT', role: 'tf', basal: 0.2, tau: 0.4 },
  { symbol: 'SMAD7', pathway: 'TGFB-EMT', role: 'effector', basal: 0.12, tau: 0.3 },
  { symbol: 'SNAI1', pathway: 'TGFB-EMT', role: 'tf', basal: 0.08, tau: 0.35 },
  { symbol: 'ZEB1', pathway: 'TGFB-EMT', role: 'tf', basal: 0.08, tau: 0.4 },
  { symbol: 'CDH1', pathway: 'TGFB-EMT', role: 'structural', basal: 0.45, tau: 0.6 },
  { symbol: 'CDH2', pathway: 'TGFB-EMT', role: 'structural', basal: 0.1, tau: 0.6 },
  { symbol: 'VIM', pathway: 'TGFB-EMT', role: 'structural', basal: 0.2, tau: 0.5 },
  { symbol: 'FN1', pathway: 'TGFB-EMT', role: 'structural', basal: 0.2, tau: 0.5 },
  { symbol: 'COL1A1', pathway: 'TGFB-EMT', role: 'structural', basal: 0.15, tau: 0.6 },
  { symbol: 'ACTA2', pathway: 'TGFB-EMT', role: 'structural', basal: 0.15, tau: 0.5 },

  // --- Inflammation / NF-kB -----------------------------------------------
  { symbol: 'TNF', pathway: 'Inflammation', role: 'ligand', basal: 0.08, tau: 0.5, uniprot: 'P01375' },
  { symbol: 'TNFRSF1A', pathway: 'Inflammation', role: 'receptor', basal: 0.25, tau: 0.5 },
  { symbol: 'NFKB1', pathway: 'Inflammation', role: 'tf', basal: 0.2, tau: 0.4, uniprot: 'P19838' },
  { symbol: 'RELA', pathway: 'Inflammation', role: 'tf', basal: 0.2, tau: 0.4 },
  { symbol: 'NFKBIA', pathway: 'Inflammation', role: 'effector', basal: 0.2, tau: 0.25 },
  { symbol: 'IL6', pathway: 'Inflammation', role: 'ligand', basal: 0.08, tau: 0.45, uniprot: 'P05231' },
  { symbol: 'IL6R', pathway: 'Inflammation', role: 'receptor', basal: 0.15, tau: 0.5 },
  { symbol: 'STAT3', pathway: 'Inflammation', role: 'tf', basal: 0.2, tau: 0.4, uniprot: 'P40763' },
  { symbol: 'SOCS3', pathway: 'Inflammation', role: 'effector', basal: 0.1, tau: 0.25 },
  { symbol: 'CXCL12', pathway: 'Inflammation', role: 'ligand', basal: 0.1, tau: 0.55 },
  { symbol: 'CXCR4', pathway: 'Inflammation', role: 'receptor', basal: 0.12, tau: 0.5 },

  // --- Interferon ---------------------------------------------------------
  { symbol: 'IFNG', pathway: 'Interferon', role: 'ligand', basal: 0.05, tau: 0.45 },
  { symbol: 'IFNGR1', pathway: 'Interferon', role: 'receptor', basal: 0.2, tau: 0.5 },
  { symbol: 'STAT1', pathway: 'Interferon', role: 'tf', basal: 0.15, tau: 0.4 },
  { symbol: 'IRF1', pathway: 'Interferon', role: 'tf', basal: 0.1, tau: 0.35 },
  { symbol: 'CXCL9', pathway: 'Interferon', role: 'ligand', basal: 0.05, tau: 0.4 },
  { symbol: 'CD274', pathway: 'Interferon', role: 'effector', basal: 0.07, tau: 0.4, uniprot: 'Q9NZQ7' },
  { symbol: 'B2M', pathway: 'Interferon', role: 'effector', basal: 0.4, tau: 0.5 },

  // --- Cell cycle ---------------------------------------------------------
  { symbol: 'MYC', pathway: 'Cell cycle', role: 'tf', basal: 0.2, tau: 0.3, uniprot: 'P01106' },
  { symbol: 'CCND1', pathway: 'Cell cycle', role: 'effector', basal: 0.15, tau: 0.35 },
  { symbol: 'CDK4', pathway: 'Cell cycle', role: 'kinase', basal: 0.2, tau: 0.4 },
  { symbol: 'MKI67', pathway: 'Cell cycle', role: 'effector', basal: 0.12, tau: 0.45 },
  { symbol: 'CDKN1A', pathway: 'Cell cycle', role: 'effector', basal: 0.15, tau: 0.3 },

  // --- Apoptosis / stress -------------------------------------------------
  { symbol: 'TP53', pathway: 'Apoptosis', role: 'tf', basal: 0.2, tau: 0.4, uniprot: 'P04637' },
  { symbol: 'BAX', pathway: 'Apoptosis', role: 'effector', basal: 0.15, tau: 0.35 },
  { symbol: 'BCL2', pathway: 'Apoptosis', role: 'effector', basal: 0.25, tau: 0.45 },
  { symbol: 'CASP3', pathway: 'Apoptosis', role: 'effector', basal: 0.12, tau: 0.35 },
];

/**
 * The regulatory topology.
 *
 * Every edge carries a `basis` string. That is not documentation for its own
 * sake: the implementation register has to be able to say what this network is
 * and is not, and an edge with no stated reason would be indistinguishable from
 * one invented to make a demo behave.
 */
export const NETWORK_EDGES: NetworkEdge[] = [
  // EGFR cascade
  { from: 'EGF', to: 'EGFR', weight: 0.9, basis: 'EGF is the canonical EGFR ligand.' },
  { from: 'TGFA', to: 'EGFR', weight: 0.7, basis: 'TGF-alpha is a second EGFR ligand.' },
  { from: 'EGFR', to: 'GRB2', weight: 0.9, basis: 'Phosphorylated EGFR recruits GRB2.' },
  { from: 'GRB2', to: 'KRAS', weight: 0.9, basis: 'GRB2/SOS loads RAS with GTP.' },
  { from: 'KRAS', to: 'BRAF', weight: 1.0, basis: 'RAS-GTP recruits and activates RAF.' },
  { from: 'BRAF', to: 'MAP2K1', weight: 1.0, basis: 'RAF phosphorylates MEK.' },
  { from: 'MAP2K1', to: 'MAPK1', weight: 1.0, basis: 'MEK phosphorylates ERK.' },
  { from: 'MAPK1', to: 'FOS', weight: 0.8, basis: 'ERK drives immediate-early transcription.' },
  { from: 'MAPK1', to: 'JUN', weight: 0.7, basis: 'ERK drives immediate-early transcription.' },
  { from: 'MAPK1', to: 'DUSP6', weight: 0.9, basis: 'DUSP6 is an ERK-induced negative feedback phosphatase.' },
  { from: 'DUSP6', to: 'MAPK1', weight: -0.8, basis: 'DUSP6 dephosphorylates ERK — the pathway’s main brake.' },
  { from: 'MAPK1', to: 'SPRY2', weight: 0.7, basis: 'Sprouty is ERK-induced.' },
  { from: 'SPRY2', to: 'GRB2', weight: -0.6, basis: 'Sprouty interferes with GRB2/SOS coupling.' },
  { from: 'FOS', to: 'MYC', weight: 0.6, basis: 'AP-1 contributes to MYC induction.' },
  { from: 'JUN', to: 'MYC', weight: 0.5, basis: 'AP-1 contributes to MYC induction.' },

  // PI3K
  { from: 'EGFR', to: 'PIK3CA', weight: 0.7, basis: 'RTK engagement activates PI3K.' },
  { from: 'PIK3CA', to: 'AKT1', weight: 1.0, basis: 'PIP3 recruits AKT to the membrane.' },
  { from: 'PTEN', to: 'AKT1', weight: -0.9, basis: 'PTEN reverses PI3K by dephosphorylating PIP3.' },
  { from: 'AKT1', to: 'MTOR', weight: 0.9, basis: 'AKT relieves TSC inhibition of mTORC1.' },
  { from: 'MTOR', to: 'RPS6KB1', weight: 0.9, basis: 'mTORC1 phosphorylates S6K.' },
  { from: 'MTOR', to: 'EIF4EBP1', weight: -0.8, basis: 'mTORC1 phosphorylation releases 4E-BP1 inhibition.' },
  { from: 'AKT1', to: 'BAX', weight: -0.5, basis: 'AKT is anti-apoptotic.' },
  { from: 'AKT1', to: 'BCL2', weight: 0.5, basis: 'AKT is anti-apoptotic.' },
  { from: 'AKT1', to: 'HIF1A', weight: 0.4, basis: 'PI3K/mTOR raises HIF1A translation.' },

  // Hypoxia
  { from: 'HIF1A', to: 'VEGFA', weight: 1.0, basis: 'VEGFA is a canonical HIF1A target.' },
  { from: 'HIF1A', to: 'SLC2A1', weight: 0.9, basis: 'GLUT1 is a canonical HIF1A target.' },
  { from: 'HIF1A', to: 'CA9', weight: 1.0, basis: 'CA9 is among the most HIF1A-specific targets.' },
  { from: 'HIF1A', to: 'LDHA', weight: 0.8, basis: 'Glycolytic switch.' },
  { from: 'HIF1A', to: 'PGK1', weight: 0.8, basis: 'Glycolytic switch.' },
  { from: 'VEGFA', to: 'KDR', weight: 0.8, basis: 'VEGFA signals through VEGFR2.' },
  { from: 'HIF1A', to: 'CXCL12', weight: 0.5, basis: 'Hypoxia raises CXCL12 in the stroma.' },

  // TGF-beta / EMT
  { from: 'TGFB1', to: 'TGFBR1', weight: 0.9, basis: 'Ligand engages the type I/II receptor complex.' },
  { from: 'TGFB1', to: 'TGFBR2', weight: 0.9, basis: 'Ligand engages the type I/II receptor complex.' },
  { from: 'TGFBR1', to: 'SMAD2', weight: 0.9, basis: 'ALK5 phosphorylates SMAD2/3.' },
  { from: 'TGFBR1', to: 'SMAD3', weight: 0.9, basis: 'ALK5 phosphorylates SMAD2/3.' },
  { from: 'TGFBR2', to: 'TGFBR1', weight: 0.6, basis: 'Type II transactivates type I.' },
  { from: 'SMAD3', to: 'SMAD7', weight: 0.8, basis: 'SMAD7 is the pathway’s induced inhibitor.' },
  { from: 'SMAD7', to: 'TGFBR1', weight: -0.8, basis: 'SMAD7 targets the receptor for degradation.' },
  { from: 'SMAD3', to: 'SNAI1', weight: 0.9, basis: 'SNAI1 is a direct SMAD target in EMT.' },
  { from: 'SMAD2', to: 'SNAI1', weight: 0.5, basis: 'SNAI1 is a direct SMAD target in EMT.' },
  { from: 'SNAI1', to: 'CDH1', weight: -1.0, basis: 'SNAI1 represses E-cadherin — the defining EMT step.' },
  { from: 'SNAI1', to: 'ZEB1', weight: 0.7, basis: 'SNAI1 induces ZEB1.' },
  { from: 'ZEB1', to: 'CDH1', weight: -0.8, basis: 'ZEB1 represses E-cadherin.' },
  { from: 'ZEB1', to: 'VIM', weight: 0.8, basis: 'Mesenchymal switch.' },
  { from: 'ZEB1', to: 'CDH2', weight: 0.7, basis: 'Cadherin switch.' },
  { from: 'SMAD3', to: 'COL1A1', weight: 0.9, basis: 'TGF-beta is the dominant fibrogenic signal.' },
  { from: 'SMAD3', to: 'FN1', weight: 0.8, basis: 'Fibronectin is a SMAD target.' },
  { from: 'SMAD3', to: 'ACTA2', weight: 0.9, basis: 'Myofibroblast conversion.' },
  { from: 'SMAD3', to: 'TGFB1', weight: 0.4, basis: 'TGF-beta autoinduction.' },
  { from: 'CDH1', to: 'SNAI1', weight: -0.3, basis: 'Junctional signalling restrains EMT.' },

  // Inflammation
  { from: 'TNF', to: 'TNFRSF1A', weight: 0.9, basis: 'TNF engages TNFR1.' },
  { from: 'TNFRSF1A', to: 'NFKB1', weight: 0.9, basis: 'TNFR1 activates canonical NF-kB.' },
  { from: 'TNFRSF1A', to: 'RELA', weight: 0.9, basis: 'TNFR1 activates canonical NF-kB.' },
  { from: 'RELA', to: 'NFKBIA', weight: 0.9, basis: 'IkB-alpha is the classic NF-kB feedback target.' },
  { from: 'NFKBIA', to: 'RELA', weight: -0.9, basis: 'IkB-alpha sequesters NF-kB.' },
  { from: 'RELA', to: 'IL6', weight: 0.9, basis: 'IL6 is an NF-kB target.' },
  { from: 'RELA', to: 'TNF', weight: 0.5, basis: 'NF-kB sustains TNF.' },
  { from: 'RELA', to: 'CD274', weight: 0.4, basis: 'NF-kB contributes to PD-L1 induction.' },
  { from: 'IL6', to: 'IL6R', weight: 0.8, basis: 'IL6 engages IL6R/gp130.' },
  { from: 'IL6R', to: 'STAT3', weight: 1.0, basis: 'gp130 activates JAK/STAT3.' },
  { from: 'STAT3', to: 'SOCS3', weight: 0.9, basis: 'SOCS3 is the induced JAK/STAT brake.' },
  { from: 'SOCS3', to: 'STAT3', weight: -0.9, basis: 'SOCS3 inhibits JAK.' },
  { from: 'STAT3', to: 'MYC', weight: 0.5, basis: 'STAT3 supports MYC.' },
  { from: 'STAT3', to: 'BCL2', weight: 0.5, basis: 'STAT3 is pro-survival.' },
  { from: 'CXCL12', to: 'CXCR4', weight: 0.8, basis: 'CXCL12 is the CXCR4 ligand.' },
  { from: 'CXCR4', to: 'MAPK1', weight: 0.4, basis: 'CXCR4 feeds into ERK.' },

  // Interferon
  { from: 'IFNG', to: 'IFNGR1', weight: 0.9, basis: 'IFN-gamma engages IFNGR.' },
  { from: 'IFNGR1', to: 'STAT1', weight: 1.0, basis: 'IFNGR activates JAK1/2-STAT1.' },
  { from: 'STAT1', to: 'IRF1', weight: 0.9, basis: 'IRF1 is a primary STAT1 target.' },
  { from: 'IRF1', to: 'CXCL9', weight: 0.9, basis: 'CXCL9 is interferon-induced.' },
  { from: 'STAT1', to: 'CD274', weight: 0.9, basis: 'PD-L1 is strongly interferon-induced.' },
  { from: 'STAT1', to: 'B2M', weight: 0.7, basis: 'Antigen presentation machinery is interferon-induced.' },
  { from: 'IRF1', to: 'CDKN1A', weight: 0.5, basis: 'IRF1 contributes to p21 induction.' },
  { from: 'SOCS3', to: 'STAT1', weight: -0.5, basis: 'SOCS3 cross-inhibits STAT1.' },

  // Cell cycle and stress
  { from: 'MYC', to: 'CCND1', weight: 0.8, basis: 'MYC drives cyclin D1.' },
  { from: 'MAPK1', to: 'CCND1', weight: 0.6, basis: 'ERK induces cyclin D1.' },
  { from: 'CCND1', to: 'CDK4', weight: 0.9, basis: 'Cyclin D binds CDK4/6.' },
  { from: 'CDK4', to: 'MKI67', weight: 0.9, basis: 'Ki-67 reports cycling.' },
  { from: 'CDKN1A', to: 'CDK4', weight: -0.9, basis: 'p21 inhibits CDK4/6.' },
  { from: 'TP53', to: 'CDKN1A', weight: 1.0, basis: 'p21 is the canonical p53 target.' },
  { from: 'TP53', to: 'BAX', weight: 0.8, basis: 'BAX is a p53 target.' },
  { from: 'BAX', to: 'CASP3', weight: 0.9, basis: 'Mitochondrial outer membrane permeabilisation to executioner caspase.' },
  { from: 'BCL2', to: 'BAX', weight: -0.9, basis: 'BCL2 antagonises BAX.' },
  { from: 'MYC', to: 'TP53', weight: 0.4, basis: 'Oncogenic stress engages p53.' },
  { from: 'CASP3', to: 'MKI67', weight: -0.7, basis: 'A dying cell is not cycling.' },
  { from: 'SNAI1', to: 'CDKN1A', weight: 0.3, basis: 'EMT is associated with reduced proliferation.' },
];

/**
 * The secreted signals, which are what make this a *spatial* model.
 *
 * Without them the tissue is a set of independent cells and a perturbation
 * stays exactly where it was applied. Diffusion lengths are the parameter that
 * decides how far it travels, and they differ by an order of magnitude across
 * this list on purpose: a juxtacrine signal and a diffusible cytokine should
 * not produce the same propagation profile.
 */
export const SECRETED_SIGNALS: SecretedSignal[] = [
  { ligand: 'TGFB1', receptor: 'TGFBR1', diffusionLength: 60, potency: 1.0, pathway: 'TGFB-EMT' },
  { ligand: 'TGFB1', receptor: 'TGFBR2', diffusionLength: 60, potency: 0.8, pathway: 'TGFB-EMT' },
  { ligand: 'VEGFA', receptor: 'KDR', diffusionLength: 120, potency: 0.9, pathway: 'Hypoxia' },
  { ligand: 'IL6', receptor: 'IL6R', diffusionLength: 150, potency: 1.0, pathway: 'Inflammation' },
  { ligand: 'TNF', receptor: 'TNFRSF1A', diffusionLength: 45, potency: 1.0, pathway: 'Inflammation' },
  { ligand: 'CXCL12', receptor: 'CXCR4', diffusionLength: 100, potency: 0.8, pathway: 'Inflammation' },
  { ligand: 'IFNG', receptor: 'IFNGR1', diffusionLength: 80, potency: 1.0, pathway: 'Interferon' },
  { ligand: 'CXCL9', receptor: 'CXCR4', diffusionLength: 90, potency: 0.3, pathway: 'Interferon' },
  { ligand: 'EGF', receptor: 'EGFR', diffusionLength: 35, potency: 0.9, pathway: 'EGFR-MAPK' },
  { ligand: 'TGFA', receptor: 'EGFR', diffusionLength: 25, potency: 0.7, pathway: 'EGFR-MAPK' },
];

// ---------------------------------------------------------------------------
// Compiled form
// ---------------------------------------------------------------------------

export interface CompiledNetwork {
  nodes: NetworkNode[];
  index: Map<string, number>;
  /** Incoming edges per node, as (source, weight) pairs. */
  incoming: { source: number; weight: number }[][];
  basal: Float64Array;
  tau: Float64Array;
  signals: {
    ligand: number;
    receptor: number;
    diffusionLength: number;
    potency: number;
    pathway: string;
  }[];
  /** Node indices by role, for the readouts. */
  ligands: number[];
  receptors: number[];
  version: string;
}

export function compileNetwork(
  nodes: NetworkNode[] = NETWORK_NODES,
  edges: NetworkEdge[] = NETWORK_EDGES,
  signals: SecretedSignal[] = SECRETED_SIGNALS,
): CompiledNetwork {
  const index = new Map(nodes.map((node, i) => [node.symbol, i]));
  const incoming: { source: number; weight: number }[][] = nodes.map(() => []);

  for (const edge of edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined) {
      throw new Error(`Network edge ${edge.from} -> ${edge.to} names a node that is not in the panel.`);
    }
    (incoming[to] as { source: number; weight: number }[]).push({ source: from, weight: edge.weight });
  }

  const basal = Float64Array.from(nodes, (node) => node.basal);
  const tau = Float64Array.from(nodes, (node) => node.tau);

  const compiledSignals = signals.map((signal) => {
    const ligand = index.get(signal.ligand);
    const receptor = index.get(signal.receptor);
    if (ligand === undefined || receptor === undefined) {
      throw new Error(`Secreted signal ${signal.ligand} -> ${signal.receptor} names a node that is not in the panel.`);
    }
    return {
      ligand,
      receptor,
      diffusionLength: signal.diffusionLength,
      potency: signal.potency,
      pathway: signal.pathway,
    };
  });

  return {
    nodes,
    index,
    incoming,
    basal,
    tau,
    signals: compiledSignals,
    ligands: [...new Set(compiledSignals.map((s) => s.ligand))],
    receptors: [...new Set(compiledSignals.map((s) => s.receptor))],
    version: '1.0.0',
  };
}

/** Pathway membership, as the pathway layer and the gene sets both need it. */
export function pathwayMembers(nodes: NetworkNode[] = NETWORK_NODES): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const node of nodes) {
    (out[node.pathway] ??= []).push(node.symbol);
  }
  return out;
}
