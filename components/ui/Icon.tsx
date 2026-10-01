/**
 * The icon set.
 *
 * Drawn here rather than pulled from a package: the lab ships as a self-hosted
 * container and a twenty-icon dependency would add a build surface and a
 * licence to track for about four kilobytes of paths. Everything is on one
 * 16-unit grid with a 1.5 stroke, round caps and joins, and `currentColor`, so
 * an icon inherits the ink of whatever it sits in and matches the text beside
 * it at any size or theme.
 *
 * The workflow glyphs are literal about the science rather than decorative —
 * propagation radiates, rescue is a capsule, comparison is a balance — because
 * the sidebar is the scientific sequence (§11.1) and the icon is the part a
 * returning user navigates by.
 */

export type IconName =
  | 'project' | 'data' | 'baseline' | 'reference' | 'experiment' | 'propagation'
  | 'predicted' | 'rescue' | 'compare' | 'interpret' | 'validate' | 'report'
  | 'methods' | 'registry' | 'about' | 'feedback' | 'implementation'
  | 'agreement' | 'review'
  | 'check' | 'alert' | 'lock' | 'arrow-right' | 'menu' | 'sun' | 'moon' | 'dot';

const PATHS: Record<IconName, React.ReactNode> = {
  /* A flask: the study itself. */
  project: <><path d="M6.5 2v4.2L3.2 12a1.6 1.6 0 0 0 1.4 2.4h6.8A1.6 1.6 0 0 0 12.8 12L9.5 6.2V2" /><path d="M5.5 2h5" /><path d="M4.9 10h6.2" /></>,
  /* Stacked records with a tick: data that has been checked. */
  data: <><ellipse cx="8" cy="4" rx="5" ry="2" /><path d="M3 4v4c0 1.1 2.2 2 5 2 .7 0 1.3 0 1.9-.2" /><path d="M3 8v4c0 1.1 2.2 2 5 2" /><path d="M10.5 12.5 12 14l2.5-3" /></>,
  /* Cells in a field: the tissue map. */
  baseline: <><circle cx="4" cy="4.5" r="1.3" /><circle cx="11.5" cy="4" r="1.3" /><circle cx="7.5" cy="8" r="1.3" /><circle cx="3.8" cy="11.5" r="1.3" /><circle cx="12" cy="11.5" r="1.3" /></>,
  /* Two sections side by side. */
  reference: <><rect x="2" y="3" width="5" height="10" rx="1" /><rect x="9" y="3" width="5" height="10" rx="1" /></>,
  /* A pipette: the intervention. */
  experiment: <><path d="M10.5 2.5 13.5 5.5" /><path d="M12 4 6.5 9.5 4 12l-1.5-1.5L5 8z" /><path d="M9 7 4.5 11.5" /></>,
  /* Signal radiating from a source. */
  propagation: <><circle cx="8" cy="8" r="1.4" /><path d="M11 5a4.2 4.2 0 0 1 0 6" /><path d="M5 11a4.2 4.2 0 0 1 0-6" /><path d="M13.2 2.8a7.3 7.3 0 0 1 0 10.4" /><path d="M2.8 13.2a7.3 7.3 0 0 1 0-10.4" /></>,
  /* The map again, with the change marked. */
  predicted: <><path d="M2.5 4.5 6 3l4 1.5L13.5 3v8.5L10 13l-4-1.5-3.5 1.5z" /><path d="M6 3v8.5" /><path d="M10 4.5V13" /></>,
  /* A capsule. */
  rescue: <><rect x="2.2" y="6" width="11.6" height="4.6" rx="2.3" transform="rotate(-38 8 8)" /><path d="M6.2 5.4 10.6 9.8" /></>,
  /* A balance: comparison without a declared winner. */
  compare: <><path d="M8 2.6v10.8" /><path d="M4 13.4h8" /><path d="M2 6.2h12" /><path d="M2 6.2 4 9.6h-4z" /><path d="M14 6.2 12 9.6h4z" /></>,
  /* Speech: prose about results. */
  interpret: <><path d="M13.5 9.5A1.8 1.8 0 0 1 11.7 11.3H5.5L2.5 13.8V4.2a1.8 1.8 0 0 1 1.8-1.8h7.4a1.8 1.8 0 0 1 1.8 1.8z" /><path d="M5.5 6h5" /><path d="M5.5 8.4h3" /></>,
  /* A clipboard with a tick. */
  validate: <><path d="M10 2.8h1.6A1.4 1.4 0 0 1 13 4.2v8.4a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 12.6V4.2a1.4 1.4 0 0 1 1.4-1.4H6" /><rect x="6" y="1.6" width="4" height="2.4" rx="0.7" /><path d="M5.8 9l1.6 1.6L10.4 7.6" /></>,
  /* A document. */
  report: <><path d="M9 1.8H4.6A1.4 1.4 0 0 0 3.2 3.2v9.6a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4V5.6z" /><path d="M9 1.8v3.8h3.8" /><path d="M5.8 8.6h4.4" /><path d="M5.8 11h4.4" /></>,

  methods: <><path d="M2.6 3.4A1.6 1.6 0 0 1 4.2 1.8H13v10.4H4.2a1.6 1.6 0 0 0-1.6 1.6z" /><path d="M2.6 13.8A1.6 1.6 0 0 1 4.2 12.2H13" /></>,
  registry: <><path d="M3 4h10" /><path d="M3 8h10" /><path d="M3 12h10" /><circle cx="1.6" cy="4" r="0.7" /><circle cx="1.6" cy="8" r="0.7" /><circle cx="1.6" cy="12" r="0.7" /></>,
  about: <><circle cx="8" cy="8" r="6.2" /><path d="M8 7.4v3.8" /><circle cx="8" cy="5.1" r="0.75" /></>,
  feedback: <><path d="M13.8 9.2a1.7 1.7 0 0 1-1.7 1.7H5.4L2.2 13.6V3.9a1.7 1.7 0 0 1 1.7-1.7h8.2a1.7 1.7 0 0 1 1.7 1.7z" /></>,
  implementation: <><path d="M5.6 3.4h8" /><path d="M5.6 8h8" /><path d="M5.6 12.6h8" /><path d="M2 3.2l1 1 1.6-1.8" /><path d="M2 7.8l1 1 1.6-1.8" /><path d="M2 12.4l1 1 1.6-1.8" /></>,
  agreement: <><path d="M2.6 12.4c1.6-.6 2.3-2 2.8-3.6.6-2 1-4.4 2.2-4.4 1 0 .9 1.6.4 3.2-.6 1.9-1.4 3.5-.5 4 .8.5 1.9-.7 2.6-1.6" /><path d="M9.6 10c1.2.9 2.6 1.4 3.8 1.4" /></>,
  review: <><path d="M8 1.9l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.7l-3.8 2 .7-4.2-3.1-3 4.3-.6z" /></>,

  check: <><path d="M3.2 8.4 6.2 11.4 12.8 4.8" /></>,
  alert: <><path d="M8 2.4 14.4 13H1.6z" /><path d="M8 6.4v3" /><circle cx="8" cy="11.1" r="0.7" /></>,
  lock: <><rect x="3.2" y="7" width="9.6" height="7" rx="1.4" /><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" /></>,
  'arrow-right': <><path d="M3 8h10" /><path d="M9 4l4 4-4 4" /></>,
  menu: <><path d="M2.4 4.4h11.2" /><path d="M2.4 8h11.2" /><path d="M2.4 11.6h11.2" /></>,
  sun: <><circle cx="8" cy="8" r="3.1" /><path d="M8 1.4v1.6" /><path d="M8 13v1.6" /><path d="M1.4 8h1.6" /><path d="M13 8h1.6" /><path d="M3.4 3.4 4.5 4.5" /><path d="M11.5 11.5l1.1 1.1" /><path d="M12.6 3.4 11.5 4.5" /><path d="M4.5 11.5 3.4 12.6" /></>,
  moon: <><path d="M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.9 5.9 0 1 0 7 7z" /></>,
  dot: <><circle cx="8" cy="8" r="2.4" /></>,
};

export function Icon({
  name,
  size = 16,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
}): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The workflow glyph for a page, where one exists. */
export const PAGE_ICON: Record<string, IconName> = {
  project: 'project', data: 'data', baseline: 'baseline', reference: 'reference',
  experiment: 'experiment', propagation: 'propagation', predicted: 'predicted',
  rescue: 'rescue', compare: 'compare', interpret: 'interpret', validate: 'validate',
  report: 'report', methods: 'methods', register: 'registry', about: 'about',
  feedback: 'feedback', implementation: 'implementation', agreement: 'agreement',
  review: 'review',
};
