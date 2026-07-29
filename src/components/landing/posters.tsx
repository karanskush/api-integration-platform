// The static twin of every WebGL scene.
//
// These are not placeholders. They are what the server renders, what a
// crawler indexes, what a reduced-motion visitor sees for the whole session,
// and what a phone gets instead of four extra canvases. Each one has to carry
// its chapter's claim on its own — if the poster is meaningless without the
// scene, the scene was carrying meaning that most visitors never receive.
//
// All server components: pure SVG, no interactivity, no client bundle.

const LATTICE_COLS = 9;
const LATTICE_ROWS = 5;
const LATTICE_FLAGGED = new Set(['3-1', '6-3', '1-4']);

export function LatticePoster() {
  const cells = [];
  const gap = 46;
  const size = 13;
  const offsetX = 62;
  const offsetY = 54;

  for (let row = 0; row < LATTICE_ROWS; row += 1) {
    for (let col = 0; col < LATTICE_COLS; col += 1) {
      const flagged = LATTICE_FLAGGED.has(`${col}-${row}`);
      // A slight shear gives the grid depth without a perspective transform,
      // which SVG would only fake anyway.
      const x = offsetX + col * gap + row * 9;
      const y = offsetY + row * gap;
      cells.push(
        <rect
          key={`${col}-${row}`}
          className={flagged ? 'pl-cell flagged' : 'pl-cell'}
          x={x}
          y={y}
          width={size}
          height={size}
          rx="2"
        />,
      );
      if (col < LATTICE_COLS - 1) {
        cells.push(
          <line key={`h${col}-${row}`} className="pl-wire" x1={x + size} y1={y + size / 2} x2={x + gap} y2={y + size / 2 + 0} />,
        );
      }
      if (row < LATTICE_ROWS - 1) {
        cells.push(
          <line key={`v${col}-${row}`} className="pl-wire" x1={x + size / 2} y1={y + size} x2={x + size / 2 + 9} y2={y + gap} />,
        );
      }
    }
  }

  return (
    <svg
      className="poster poster-lattice"
      viewBox="0 0 600 340"
      role="img"
      aria-label="A pasted specification resolving into a lattice of typed tools, with three operations flagged as unsafe."
    >
      {cells}
      <text className="p-micro" x="62" y="30">SPEC IN</text>
      <text className="p-micro right" x="538" y="30" textAnchor="end">38 TYPED TOOLS · 3 UNSAFE FLAGGED</text>
    </svg>
  );
}

export function ConstellationPoster() {
  const agents = [
    { y: 78, name: 'Claude' },
    { y: 158, name: 'Cursor' },
    { y: 238, name: 'Copilot' },
  ];

  return (
    <svg
      className="poster poster-constellation"
      viewBox="0 0 600 320"
      role="img"
      aria-label="One import in the middle, feeding a human integration page on one side and Claude, Cursor and Copilot on the other."
    >
      {/* page branch */}
      <path className="pc-edge" d="M 288,158 C 240,158 220,150 176,146" />
      <rect className="pc-plate" x="52" y="112" width="124" height="72" rx="3" />
      <text className="p-micro" x="114" y="102" textAnchor="middle">FOR HUMANS</text>
      <text className="pc-label" x="114" y="153" textAnchor="middle">integration</text>
      <text className="pc-label" x="114" y="171" textAnchor="middle">page</text>

      {/* core */}
      <circle className="pc-core-ring" cx="300" cy="158" r="30" />
      <circle className="pc-core" cx="300" cy="158" r="12" />
      <text className="p-micro" x="300" y="212" textAnchor="middle">ONE IMPORT</text>

      {/* agent branch */}
      {agents.map((agent) => (
        <g key={agent.name}>
          <path className="pc-edge agent" d={`M 312,158 C 366,158 388,${agent.y} 432,${agent.y}`} />
          <circle className="pc-agent" cx="446" cy={agent.y} r="13" />
          <text className="pc-agent-label" x="470" y={agent.y + 4}>{agent.name}</text>
        </g>
      ))}
      <text className="p-micro" x="432" y="42">FOR AGENTS · HOSTED MCP</text>
    </svg>
  );
}

// The drafting-plate lineage figure, carried over from the previous design and
// re-pigmented. The fourth row is still the point: trial_period_days has no
// producer and is drawn with nothing attached to it.
const LINEAGE_ROWS = [
  { field: 'body.customer', note: 'produced_by_api', linked: true },
  { field: 'body.items[].price', note: 'produced_by_api', linked: true },
  { field: 'body.trial_period_days', note: 'caller_supplied', linked: false },
];
const ROW_Y = [92, 140, 188];
const BOX = { w: 236, h: 72 };
const CONSUMER = { x: 452, y: 44, w: 292, h: 188 };

export function LineagePoster() {
  return (
    <svg
      className="poster poster-lineage"
      viewBox="0 0 760 268"
      role="img"
      aria-label="Lineage: POST /customers' response id feeds POST /subscriptions' customer field, GET /prices' response id feeds its price field, and trial_period_days has no producer and is left unattached."
    >
      <g className="lin-node">
        <rect x="8" y="46" rx="2" width={BOX.w} height={BOX.h} />
        <text className="lin-op" x="22" y="70">POST /customers</text>
        <text className="lin-field" x="22" y="92">response.id</text>
        <text className="lin-tag" x="22" y="110">PRODUCES</text>
      </g>
      <g className="lin-node">
        <rect x="8" y="150" rx="2" width={BOX.w} height={BOX.h} />
        <text className="lin-op" x="22" y="174">GET /prices</text>
        <text className="lin-field" x="22" y="196">response.data[].id</text>
        <text className="lin-tag" x="22" y="214">PRODUCES</text>
      </g>

      <g className="lin-edges">
        <path className="lin-edge" d="M 244,82 C 330,82 372,92 452,92" />
        <text className="lin-why" x="348" y="76" textAnchor="middle">foreign_key_name · high</text>
        <path className="lin-edge" d="M 244,186 C 330,186 372,140 452,140" />
        <text className="lin-why" x="348" y="176" textAnchor="middle">distinctive_name · high</text>
      </g>

      <g className="lin-node consumer">
        <rect x={CONSUMER.x} y={CONSUMER.y} rx="2" width={CONSUMER.w} height={CONSUMER.h} />
        <text className="lin-op" x={CONSUMER.x + 16} y={CONSUMER.y + 26}>POST /subscriptions</text>
        <text className="lin-tag" x={CONSUMER.x + 16} y={CONSUMER.y + 44}>REQUIRES</text>
        {LINEAGE_ROWS.map((row, i) => (
          <g key={row.field}>
            <text className="lin-field" x={CONSUMER.x + 16} y={ROW_Y[i] + 4}>{row.field}</text>
            <text
              className={row.linked ? 'lin-origin' : 'lin-origin open'}
              x={CONSUMER.x + CONSUMER.w - 16}
              y={ROW_Y[i] + 4}
              textAnchor="end"
            >
              {row.note}
            </text>
          </g>
        ))}
        <text className="lin-none" x={CONSUMER.x + 16} y={ROW_Y[2] + 26}>
          ← nothing produces this. We say so, rather than guess.
        </text>
      </g>
    </svg>
  );
}

const DRIFT_FIELDS = ['id: string', 'amount: integer', 'currency: string', 'status: enum'];

export function DriftPoster() {
  const rowH = 34;
  const gap = 8;
  const top = 74;

  return (
    <svg
      className="poster poster-drift"
      viewBox="0 0 600 320"
      role="img"
      aria-label="The documented response shape beside the shape the running service actually returned, with one extra undocumented status value caught and patched into the tool schema."
    >
      <text className="p-micro" x="42" y="46">DOCUMENTED</text>
      <text className="p-micro" x="330" y="46">OBSERVED</text>

      {DRIFT_FIELDS.map((field, i) => (
        <g key={field}>
          <rect className="pd-row ghost" x="42" y={top + i * (rowH + gap)} width="212" height={rowH} rx="2" />
          <text className="pd-field ghost" x="56" y={top + i * (rowH + gap) + 22}>{field}</text>
          <rect className="pd-row" x="330" y={top + i * (rowH + gap)} width="212" height={rowH} rx="2" />
          <text className="pd-field" x="344" y={top + i * (rowH + gap) + 22}>{field}</text>
        </g>
      ))}

      {/* the drift, caught */}
      <rect className="pd-row caught" x="330" y={top + 4 * (rowH + gap)} width="212" height={rowH} rx="2" />
      <text className="pd-field caught" x="344" y={top + 4 * (rowH + gap) + 22}>status: &quot;pending_review&quot;</text>
      <path className="pd-patch" d={`M 326,${top + 4 * (rowH + gap) + rowH / 2} L 258,${top + 4 * (rowH + gap) + rowH / 2}`} />
      <text className="p-micro caught" x="42" y={top + 4 * (rowH + gap) + 22}>← PATCHED</text>
    </svg>
  );
}

const SCORE_R = 96;
const SCORE_C = 2 * Math.PI * SCORE_R;
const SCORE_VALUE = 87;

const SCORE_SUBS = [
  { name: 'Error quality', value: 78, live: true },
  { name: 'Doc drift', value: 84, live: true },
  { name: 'Auth clarity', value: 92, live: false },
  { name: 'Idempotency', value: 95, live: false },
];

export function ScorePoster() {
  return (
    <svg
      className="poster poster-score"
      viewBox="0 0 260 300"
      role="img"
      aria-label="A worked example of an Agent-Ready Score reading 87 out of 100, with error quality and doc drift earned by live probes and auth clarity and idempotency graded from the document."
    >
      <g transform="translate(130 118)">
        <circle className="ps-ticks" r="112" />
        <circle className="ps-track" r={SCORE_R} />
        <circle
          className="ps-arc"
          r={SCORE_R}
          transform="rotate(-90)"
          strokeDasharray={SCORE_C}
          strokeDashoffset={SCORE_C * (1 - SCORE_VALUE / 100)}
        />
        <text className="ps-num" y="14" textAnchor="middle">{SCORE_VALUE}</text>
        <text className="ps-label" y="44" textAnchor="middle">AGENT-READY</text>
      </g>

      {SCORE_SUBS.map((sub, i) => (
        <g key={sub.name} transform={`translate(20 ${248 + i * 0})`}>
          <rect className="ps-sub-track" x={i * 56} y="0" width="48" height="3" rx="1.5" />
          <rect
            className={sub.live ? 'ps-sub earned' : 'ps-sub'}
            x={i * 56}
            y="0"
            width={(48 * sub.value) / 100}
            height="3"
            rx="1.5"
          />
        </g>
      ))}
      <text className="p-micro" x="20" y="272">■ EARNED LIVE</text>
      <text className="p-micro" x="20" y="288">■ GRADED FROM THE DOCUMENT</text>
    </svg>
  );
}
