/**
 * The NanoSchool Expert Reviewer Agreement & Confidentiality Undertaking.
 *
 * Transcribed verbatim from the issued document. Nothing here is summarised,
 * shortened or reworded, and that is not fussiness: this is the text a reviewer
 * signs, and an acknowledgement is only meaningful if what was displayed is
 * what was agreed. A paraphrase on screen and a signature in the database would
 * record consent to something nobody wrote.
 *
 * AGREEMENT_VERSION and the content fingerprint exist for the same reason. The
 * acknowledgement stored on the hub carries both, so a later change to this
 * text is detectable rather than silently applying to people who agreed to the
 * previous wording. Change the text and the fingerprint moves; the version is
 * bumped by hand, so the change has to be deliberate.
 */

export const AGREEMENT_VERSION = 'nanoschool-reviewer-agreement-2026-09';

export const AGREEMENT_TITLE = 'Expert Reviewer Agreement & Confidentiality Undertaking';
export const AGREEMENT_SUBTITLE = 'For Confidential Pre-Release Expert Review';

export const AGREEMENT_PREAMBLE = [
  'NanoSchool/NSTC develops Virtual Live Labs across scientific, technological and interdisciplinary areas, ' +
    'including biotechnology, life sciences, genomics and omics, medical and healthcare data, artificial ' +
    'intelligence, machine learning, data science, nanoscience, nanotechnology, materials science, engineering, ' +
    'cybersecurity and related domains.',
  'You are being provided access as an Expert Reviewer to help NanoSchool evaluate and improve a pre-release ' +
    'Virtual Live Lab before it is made publicly available.',
];

export interface AgreementBlock {
  /** A paragraph of running text. */
  text?: string;
  /** A bulleted list. */
  bullets?: string[];
  /** A sub-heading inside a section, as the document uses in section 4. */
  subheading?: string;
}

export interface AgreementSection {
  number: string;
  heading: string;
  blocks: AgreementBlock[];
}

export const AGREEMENT_SECTIONS: AgreementSection[] = [
  {
    number: '1',
    heading: 'Purpose of Expert Review',
    blocks: [
      { text: 'The Reviewer is invited to independently assess, as applicable:' },
      {
        bullets: [
          'Scientific or technical accuracy',
          'Methodology and workflow',
          'Dataset and input suitability',
          'Parameters, assumptions and calculations',
          'Algorithms, AI/ML models or computational logic',
          'Outputs, visualisations and interpretation',
          'Reproducibility and validation',
          'Educational relevance and learner experience',
          'Limitations, safety, privacy, security or ethical concerns',
          'Errors, omissions and recommended improvements',
        ],
      },
      { text: 'The objective is to identify weaknesses and strengthen the Live Lab before release.' },
    ],
  },
  {
    number: '2',
    heading: 'Confidential Pre-Release Access',
    blocks: [
      {
        text:
          'The Live Lab provided for review is confidential, proprietary, under development and may contain ' +
          'unreleased features.',
      },
      { text: 'Confidential material may include:' },
      {
        text:
          'Live Lab concepts, architecture, workflows, algorithms, source material, datasets, models, parameters, ' +
          'software logic, AI prompts, screenshots, reports, interfaces, documentation, assessments, teaching ' +
          'scenarios, development plans and other unreleased information.',
      },
      { text: 'The Reviewer shall use this material only for the agreed expert-review purpose.' },
    ],
  },
  {
    number: '3',
    heading: 'Please Do Not Share or Publicly Disclose',
    blocks: [
      { text: 'Without prior written approval from NanoSchool/NSTC, the Reviewer should not:' },
      {
        bullets: [
          'Share login credentials, access links or review accounts',
          'Provide access to students, colleagues, institutions or third parties',
          'Publicly demonstrate the pre-release Live Lab',
          'Publish screenshots, recordings or internal documentation',
          'Post unreleased Live Lab information on social media or professional networks',
          'Reproduce or commercially use substantial proprietary Live Lab material',
        ],
      },
      {
        text:
          'If consultation with another specialist is required, prior approval should be obtained from ' +
          'NanoSchool/NSTC.',
      },
    ],
  },
  {
    number: '4',
    heading: 'Domain-Specific Responsible Review',
    blocks: [
      { subheading: 'Biotechnology, Genomics, Omics & Medical Data' },
      {
        text:
          'Review should preferably use NanoSchool-provided, synthetic, authorised public or appropriately ' +
          'de-identified datasets.',
      },
      {
        text:
          'Personally identifiable information, protected health information, confidential patient information, ' +
          'identifiable genomic data or restricted institutional datasets should not be uploaded unless ' +
          'specifically authorised.',
      },
      {
        text:
          'Live Lab outputs are intended for educational and expert-review purposes and should not be treated as ' +
          'clinical diagnosis, patient-management advice or independently validated medical conclusions.',
      },
      { subheading: 'Artificial Intelligence, Machine Learning & Data Science' },
      { text: 'AI-generated explanations, predictions or recommendations should be critically evaluated for:' },
      {
        bullets: [
          'Accuracy',
          'Bias',
          'Unsupported claims',
          'Hallucination',
          'Reproducibility',
          'Explainability',
          'Appropriate interpretation',
        ],
      },
      {
        text:
          'Confidential Live Lab material should not be submitted to external AI systems, LLMs, cloud AI tools, ' +
          'code assistants or third-party platforms without prior authorisation.',
      },
      { subheading: 'Cybersecurity' },
      {
        text:
          'Cybersecurity Live Labs should be reviewed only within authorised, controlled or sandboxed environments.',
      },
      { text: 'Review access does not authorise:' },
      {
        bullets: [
          'Unauthorised system scanning',
          'Access to third-party systems',
          'Credential harvesting',
          'Deployment of malware',
          'Exploitation of real systems',
          'Bypassing security controls outside the approved Lab environment',
        ],
      },
      {
        text: 'Any security vulnerability identified during review should be reported privately to NanoSchool/NSTC.',
      },
      { subheading: 'Nanoscience, Nanotechnology, Materials & Engineering' },
      {
        text:
          'Computational predictions, models, simulations and educational outputs should be reviewed for ' +
          'scientific validity, assumptions, parameter appropriateness and limitations.',
      },
      {
        text:
          'Virtual or computational results should not be represented as equivalent to independently validated ' +
          'experimental, industrial, safety or regulatory results unless appropriate validation exists.',
      },
    ],
  },
  {
    number: '5',
    heading: 'Intellectual Property',
    blocks: [
      {
        text:
          'Existing NanoSchool/NSTC intellectual property, including original architecture, educational design, ' +
          'software, workflows, documentation, branding and proprietary Live Lab components, remains with ' +
          'NanoSchool/NSTC and/or the applicable rights holder.',
      },
      { text: 'The Reviewer retains ownership of their:' },
      {
        bullets: [
          'Pre-existing knowledge',
          'Independently developed research',
          'Existing publications',
          'Proprietary datasets',
          'Software',
          'Original intellectual property',
        ],
      },
      { text: 'Access for review does not transfer ownership to either party.' },
      {
        text:
          'Third-party publications, datasets, databases, software and open-source components remain subject to ' +
          'their respective ownership and licence conditions.',
      },
    ],
  },
  {
    number: '6',
    heading: 'Reviewer Feedback',
    blocks: [
      { text: 'The Reviewer is encouraged to provide clear, independent and constructive recommendations.' },
      { text: 'NanoSchool/NSTC may:' },
      {
        bullets: [
          'Accept a recommendation',
          'Partially implement it',
          'Modify it',
          'Combine it with other recommendations',
          'Conduct additional validation',
          'Decide not to implement it',
        ],
      },
      {
        text:
          'Feedback voluntarily provided specifically for improvement of the Live Lab may be used, adapted and ' +
          'incorporated by NanoSchool/NSTC.',
      },
      {
        text:
          'If a proposed contribution contains substantial original intellectual property, software, content, ' +
          'datasets or research belonging to the Reviewer, separate written permission should be obtained before ' +
          'incorporation.',
      },
    ],
  },
  {
    number: '7',
    heading: 'Important Issues to Report',
    blocks: [
      { text: 'Please highlight any issue involving:' },
      {
        bullets: [
          'Scientific or technical error',
          'Unsupported interpretation',
          'Invalid calculation or statistical analysis',
          'Misleading AI-generated output',
          'Dataset misuse',
          'Bias',
          'Reproducibility problem',
          'Privacy concern',
          'Security vulnerability',
          'Ethical or safety concern',
          'Copyright, licensing or attribution issue',
        ],
      },
      {
        text:
          'Where reasonably possible, major scientific or technical corrections may be supported by publications, ' +
          'standards, official documentation or recognised databases.',
      },
    ],
  },
  {
    number: '8',
    heading: 'Independent Review – Not Automatic Endorsement',
    blocks: [
      { text: 'Participation as an Expert Reviewer does not mean that the Reviewer:' },
      {
        bullets: [
          'Endorses the final Live Lab',
          'Is responsible for the final product',
          'Has approved future versions',
          'Is an employee of NanoSchool/NSTC',
          'Is responsible for changes made after the review',
        ],
      },
      { text: 'NanoSchool/NSTC remains responsible for final implementation decisions and release approval.' },
    ],
  },
  {
    number: '9',
    heading: 'Reviewer Recognition',
    blocks: [
      {
        text:
          'With the Reviewer’s separate consent, NanoSchool/NSTC may acknowledge their expert contribution.',
      },
      {
        text:
          'Use of the Reviewer’s name, photograph, designation, institutional affiliation, testimonial or ' +
          'statement for promotional purposes will require appropriate permission.',
      },
    ],
  },
  {
    number: '10',
    heading: 'Review Access and Version',
    blocks: [
      { text: 'Review access may be modified, suspended or closed following completion of the review.' },
      {
        text:
          'The review applies only to the specific Live Lab version/build provided to the Reviewer. Significant ' +
          'subsequent modifications may require additional review.',
      },
      {
        text:
          'Confidential review materials should be deleted or returned when reasonably requested by ' +
          'NanoSchool/NSTC.',
      },
      { text: 'Confidentiality obligations continue for information that remains confidential or non-public.' },
    ],
  },
];

/** The confirmation the reviewer ticks, word for word. */
export const AGREEMENT_CONFIRMATION =
  'I confirm that I have read and understood this Expert Reviewer Agreement and will use the pre-release Virtual ' +
  'Live Lab only for the agreed confidential expert-review purpose.';

export const AGREEMENT_ISSUER = {
  lines: [
    'NanoSchool / NSTC (Nano Science & Technology Consortium)',
    'A division of IT Break Com Pvt. Ltd.',
    'A-118, Level 1B, Sector 63, Noida, Uttar Pradesh – 201301, India',
  ],
  purpose: 'Confidential pre-release expert review of NanoSchool Virtual Live Labs.',
};

/* ------------------------------------------------------------------ *
 * Reviewer Acknowledgement
 * ------------------------------------------------------------------ */

export const REVIEW_ROLES = [
  { id: 'SCIENTIFIC', label: 'Scientific Review' },
  { id: 'TECHNICAL', label: 'Technical Review' },
  { id: 'AI_COMPUTATIONAL', label: 'AI/Computational Review' },
  { id: 'DATA_METHODOLOGY', label: 'Data/Methodology Review' },
  { id: 'EDUCATIONAL_UX', label: 'Educational/UX Review' },
  { id: 'SECURITY_PRIVACY', label: 'Security/Privacy Review' },
  { id: 'COMPLETE', label: 'Complete Expert Review' },
] as const;

export type ReviewRoleId = (typeof REVIEW_ROLES)[number]['id'];

export interface AcknowledgementForm {
  labTitle: string;
  domain: string;
  reviewBuild: string;
  reviewerName: string;
  designation: string;
  institution: string;
  email: string;
  dateAccessProvided: string;
  expectedCompletion: string;
  reviewRoles: ReviewRoleId[];
  /** Typed name, standing as the signature the document asks for. */
  signature: string;
  signedDate: string;
  confirmed: boolean;
}

/**
 * What the acknowledgement must carry before it can be recorded.
 *
 * The confirmation tick and the signature are both required and are not the
 * same thing: one is assent to the text, the other is the reviewer putting
 * their name to it, and the document asks for both. Institution is required
 * too, because section 9 turns on institutional affiliation and a blank there
 * makes the recognition clause unusable.
 */
export function missingAcknowledgementFields(form: AcknowledgementForm): string[] {
  const missing: string[] = [];
  if (!form.reviewerName.trim()) missing.push('Reviewer name');
  if (!form.designation.trim()) missing.push('Designation');
  if (!form.institution.trim()) missing.push('Institution / organisation');
  if (!form.email.trim()) missing.push('Email');
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) missing.push('A valid email address');
  if (!form.domain.trim()) missing.push('Domain');
  if (form.reviewRoles.length === 0) missing.push('At least one review role');
  if (!form.signature.trim()) missing.push('Reviewer signature');
  if (!form.confirmed) missing.push('Confirmation that you have read and understood the agreement');
  return missing;
}

/**
 * A stable fingerprint of the agreement text as displayed.
 *
 * Stored with every acknowledgement so a change to the wording is detectable
 * afterwards. Not a cryptographic hash and not trying to be: it is a drift
 * detector, and the property it needs is that different text gives a different
 * value.
 */
export function agreementFingerprint(): string {
  const text = [
    AGREEMENT_TITLE,
    AGREEMENT_SUBTITLE,
    ...AGREEMENT_PREAMBLE,
    ...AGREEMENT_SECTIONS.flatMap((s) => [
      s.number,
      s.heading,
      ...s.blocks.flatMap((b) => [b.subheading ?? '', b.text ?? '', ...(b.bullets ?? [])]),
    ]),
    AGREEMENT_CONFIRMATION,
  ].join('');

  // FNV-1a, 32-bit. Small, deterministic, and dependency-free.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}-${text.length}`;
}
