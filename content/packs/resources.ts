/**
 * Curated scientific resources: pathway gene sets, marker panels, cell-state
 * signatures and ligand-receptor pairs.
 *
 * These are *curated*, which the lab says on every screen that shows them.
 * Where a set corresponds to a database entry the identifier is given, so a
 * reader can check it against the source rather than against this file. Where a
 * set is assembled from the curated network in `engine/src/propagate/network`,
 * it says that instead — a gene set drawn from the same model that generated
 * the data would be circular if it were presented as independent evidence, and
 * it is not presented that way.
 */

import type { GeneSet } from '../../engine/src/baseline/index';
import type { MarkerPanel } from '../../engine/src/annotate/index';
import type { LigandReceptorPair } from '../../engine/src/spatial/communication';

export const RESOURCE_VERSION = '1.0.0';

/**
 * Pathway gene sets.
 *
 * Signed: a negative weight means the pathway's activation *lowers* that
 * member, so a repressed target pulls the activity score down rather than up.
 * An unsigned set cannot distinguish "the pathway is on" from "these genes
 * happen to be expressed", which for EMT is the difference between a
 * mesenchymal state and an epithelial one.
 */
export const PATHWAY_SETS: GeneSet[] = [
  {
    id: 'PW:EGFR-MAPK',
    name: 'EGFR / MAPK signalling',
    source: 'Curated; corresponds to Reactome R-HSA-177929 (Signaling by EGFR).',
    members: {
      EGFR: 1, GRB2: 1, KRAS: 1, BRAF: 1, MAP2K1: 1, MAPK1: 1, FOS: 1, JUN: 1,
      DUSP6: 1, SPRY2: 1, EGF: 0.5, TGFA: 0.5,
    },
  },
  {
    id: 'PW:PI3K-AKT',
    name: 'PI3K / AKT / mTOR signalling',
    source: 'Curated; corresponds to Reactome R-HSA-1257604 (PIP3 activates AKT signaling).',
    members: { PIK3CA: 1, AKT1: 1, MTOR: 1, RPS6KB1: 1, PTEN: -1, EIF4EBP1: -0.5 },
  },
  {
    id: 'PW:HYPOXIA',
    name: 'Hypoxia response',
    source: 'Curated; corresponds to Reactome R-HSA-1234174 (Cellular response to hypoxia).',
    members: { HIF1A: 1, VEGFA: 1, SLC2A1: 1, CA9: 1, LDHA: 1, PGK1: 1 },
  },
  {
    id: 'PW:TGFB-EMT',
    name: 'TGF-beta signalling and EMT',
    source: 'Curated; corresponds to Reactome R-HSA-170834 (Signaling by TGF-beta Receptor Complex) and the EMT hallmark.',
    members: {
      TGFB1: 1, TGFBR1: 1, TGFBR2: 1, SMAD2: 1, SMAD3: 1, SNAI1: 1, ZEB1: 1,
      VIM: 1, CDH2: 1, FN1: 1, COL1A1: 1, ACTA2: 1,
      CDH1: -1, SMAD7: -0.5,
    },
  },
  {
    id: 'PW:INFLAMMATION',
    name: 'NF-kB inflammatory signalling',
    source: 'Curated; corresponds to Reactome R-HSA-5357801 and the TNFA_SIGNALING_VIA_NFKB hallmark.',
    members: { TNF: 1, TNFRSF1A: 1, NFKB1: 1, RELA: 1, IL6: 1, IL6R: 1, STAT3: 1, CXCL12: 0.5, NFKBIA: -0.5, SOCS3: -0.5 },
  },
  {
    id: 'PW:INTERFERON',
    name: 'Interferon-gamma response',
    source: 'Curated; corresponds to Reactome R-HSA-877300 and the INTERFERON_GAMMA_RESPONSE hallmark.',
    members: { IFNG: 1, IFNGR1: 1, STAT1: 1, IRF1: 1, CXCL9: 1, CD274: 1, B2M: 1 },
  },
  {
    id: 'PW:CELL-CYCLE',
    name: 'Cell cycle and proliferation',
    source: 'Curated; corresponds to Reactome R-HSA-1640170 (Cell Cycle).',
    members: { MYC: 1, CCND1: 1, CDK4: 1, MKI67: 1, CDKN1A: -1 },
  },
  {
    id: 'PW:APOPTOSIS',
    name: 'Apoptosis',
    source: 'Curated; corresponds to Reactome R-HSA-109581 (Apoptosis).',
    members: { TP53: 1, BAX: 1, CASP3: 1, CDKN1A: 0.5, BCL2: -1 },
  },
];

/**
 * Cell-state signatures.
 *
 * Deliberately overlapping with the pathway sets in places — a proliferative
 * state and the cell-cycle pathway share members — because they answer
 * different questions. The pathway score asks whether a pathway is active
 * relative to a size-matched random set; the state score asks whether a cell
 * looks like this state relative to expression-matched controls.
 */
export const STATE_SIGNATURES: GeneSet[] = [
  { id: 'ST:PROLIFERATIVE', name: 'Proliferative', source: 'Curated cell-cycle markers.',
    members: { MKI67: 1, CCND1: 1, CDK4: 1, MYC: 1 } },
  { id: 'ST:MESENCHYMAL', name: 'Mesenchymal / EMT-high', source: 'Curated EMT markers.',
    members: { VIM: 1, CDH2: 1, SNAI1: 1, ZEB1: 1, FN1: 1 } },
  { id: 'ST:EPITHELIAL', name: 'Epithelial', source: 'Curated junctional markers.',
    members: { CDH1: 1, EGFR: 0.5 } },
  { id: 'ST:HYPOXIC', name: 'Hypoxic', source: 'Curated HIF1A targets.',
    members: { CA9: 1, SLC2A1: 1, LDHA: 1, PGK1: 1, HIF1A: 1 } },
  { id: 'ST:INFLAMED', name: 'Inflamed', source: 'Curated NF-kB targets.',
    members: { TNF: 1, IL6: 1, NFKB1: 1, RELA: 1 } },
  { id: 'ST:INTERFERON-ACTIVATED', name: 'Interferon-activated', source: 'Curated IFN-gamma response genes.',
    members: { STAT1: 1, IRF1: 1, CXCL9: 1, B2M: 1, CD274: 1 } },
  { id: 'ST:APOPTOTIC', name: 'Apoptotic', source: 'Curated intrinsic apoptosis markers.',
    members: { BAX: 1, CASP3: 1, TP53: 1 } },
  { id: 'ST:FIBROTIC', name: 'Matrix-producing', source: 'Curated myofibroblast markers.',
    members: { COL1A1: 1, FN1: 1, ACTA2: 1 } },
];

/**
 * Marker panels for cell typing.
 *
 * Written with negatives as well as positives. A panel of positives alone
 * assigns a macrophage to the CAF class whenever it happens to express some
 * matrix genes, which in a tumour it often does; requiring CDH1 to be *low*
 * for a fibroblast is what keeps the two apart.
 */
export const TUMOUR_MICROENVIRONMENT_PANEL: MarkerPanel = {
  id: 'MP:TME-V1',
  version: '1.0.0',
  source: 'Curated from canonical lineage markers for the tumour microenvironment.',
  positive: {
    Tumour: ['CDH1', 'EGFR', 'MYC', 'CCND1'],
    CAF: ['COL1A1', 'ACTA2', 'FN1', 'VIM'],
    Macrophage: ['TNF', 'IL6', 'NFKB1', 'CD274'],
    'T cell': ['IFNG', 'CXCR4', 'B2M'],
    Endothelial: ['KDR', 'CDH2'],
  },
  negative: {
    Tumour: ['COL1A1', 'ACTA2', 'IFNG'],
    CAF: ['CDH1', 'IFNG'],
    Macrophage: ['CDH1', 'COL1A1'],
    'T cell': ['CDH1', 'COL1A1', 'EGFR'],
    Endothelial: ['CDH1', 'IFNG'],
  },
};

/**
 * Ligand-receptor pairs, with mode and range.
 *
 * `mode` decides the distance cut-off the optimal-transport model uses, and the
 * difference between a contact-dependent and a secreted interaction is an order
 * of magnitude — scoring both over the same radius would report juxtacrine
 * signalling between cells a hundred micrometres apart.
 */
export const LIGAND_RECEPTOR_PAIRS: LigandReceptorPair[] = [
  { id: 'LR:TGFB1-TGFBR', ligand: 'TGFB1', receptorSubunits: ['TGFBR1', 'TGFBR2'], source: 'Curated; CellChatDB/OmniPath list the TGFB1-TGFBR1/2 complex.', mode: 'secreted', pathway: 'TGFB-EMT' },
  { id: 'LR:VEGFA-KDR', ligand: 'VEGFA', receptorSubunits: ['KDR'], source: 'Curated; canonical VEGF-A / VEGFR2 interaction.', mode: 'secreted', pathway: 'Hypoxia' },
  { id: 'LR:IL6-IL6R', ligand: 'IL6', receptorSubunits: ['IL6R'], source: 'Curated; IL6 / IL6R-gp130.', mode: 'secreted', pathway: 'Inflammation' },
  { id: 'LR:TNF-TNFRSF1A', ligand: 'TNF', receptorSubunits: ['TNFRSF1A'], source: 'Curated; TNF / TNFR1.', mode: 'secreted', pathway: 'Inflammation' },
  { id: 'LR:CXCL12-CXCR4', ligand: 'CXCL12', receptorSubunits: ['CXCR4'], source: 'Curated; CXCL12 / CXCR4.', mode: 'secreted', pathway: 'Inflammation' },
  { id: 'LR:IFNG-IFNGR1', ligand: 'IFNG', receptorSubunits: ['IFNGR1'], source: 'Curated; IFN-gamma / IFNGR.', mode: 'secreted', pathway: 'Interferon' },
  { id: 'LR:CXCL9-CXCR4', ligand: 'CXCL9', receptorSubunits: ['CXCR4'], source: 'Curated; CXCL9 has lower affinity for CXCR4 than CXCR3, which this panel does not measure.', mode: 'secreted', pathway: 'Interferon' },
  { id: 'LR:EGF-EGFR', ligand: 'EGF', receptorSubunits: ['EGFR'], source: 'Curated; EGF / EGFR.', mode: 'contact', pathway: 'EGFR-MAPK' },
  { id: 'LR:TGFA-EGFR', ligand: 'TGFA', receptorSubunits: ['EGFR'], source: 'Curated; TGF-alpha / EGFR, predominantly juxtacrine.', mode: 'contact', pathway: 'EGFR-MAPK' },
];

/**
 * What this resource pack is, said once, for the panel that displays it.
 */
export const RESOURCE_PROVENANCE = {
  version: RESOURCE_VERSION,
  statement:
    'These gene sets, signatures, marker panels and ligand-receptor pairs are curated for this lab, with the corresponding ' +
    'Reactome or interaction-database entry named where one exists. They are not a download of any database, and the ' +
    'identifiers are given so that a reader can check them against the source rather than against this pack.',
  circularityNote:
    'The bundled demonstration case is generated by the same curated network these sets are drawn from. On that dataset a ' +
    'pathway score is therefore measuring the simulator, not confirming it — a point the baseline panel repeats where it ' +
    'shows the demonstration case. On an uploaded dataset the sets are ordinary prior knowledge and the circularity does not arise.',
  sources: [
    'Reactome: https://reactome.org',
    'UniProt: https://www.uniprot.org',
    'CellChatDB / OmniPath interaction records, for the ligand-receptor list.',
  ],
};
