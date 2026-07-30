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

/** A pointy-right hexagon, matching CircleGeometry(r, 6) in the live scene. */
function hexPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
}

export function ConstellationPoster() {
  const agents = [
    { y: 74, name: 'Claude' },
    { y: 160, name: 'Cursor' },
    { y: 246, name: 'Copilot' },
  ];

  return (
    <svg
      className="poster poster-constellation"
      viewBox="0 0 600 320"
      role="img"
      aria-label="One import in the middle: it renders a human integration page on one side, and serves a hosted MCP endpoint on the other that Claude, Cursor and Copilot call."
    >
      <defs>
        <pattern id="pc-dots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle className="p-dot" cx="1.2" cy="1.2" r="1.2" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="600" height="320" fill="url(#pc-dots)" />

      {/* broadcast rings — one import, radiating to both surfaces */}
      <circle className="pc-ring" cx="252" cy="160" r="44" />
      <circle className="pc-ring far" cx="252" cy="160" r="70" />

      {/* page branch */}
      <path className="pc-edge" d="M 230,160 C 214,160 196,160 178,160" />
      <rect className="pc-plate" x="44" y="118" width="132" height="84" rx="3" />
      <line className="pc-doc head" x1="56" y1="133" x2="164" y2="133" />
      <line className="pc-doc" x1="56" y1="149" x2="164" y2="149" />
      <line className="pc-doc" x1="56" y1="161" x2="164" y2="161" />
      <line className="pc-doc" x1="56" y1="173" x2="130" y2="173" />
      <rect className="pc-try" x="56" y="182" width="38" height="12" rx="2" />
      <text className="p-micro" x="110" y="104" textAnchor="middle">FOR HUMANS</text>
      <text className="p-micro iris" x="110" y="222" textAnchor="middle">INTEGRATION PAGE</text>

      {/* core */}
      <circle className="pc-core-ring" cx="252" cy="160" r="22" />
      <circle className="pc-core" cx="252" cy="160" r="9" />
      <text className="p-micro" x="252" y="216" textAnchor="middle">ONE IMPORT</text>

      {/* agent branch — the hosted MCP server we run, then its clients */}
      <path className="pc-edge agent" d="M 274,160 C 300,160 332,160 362,160" />
      <polygon className="pc-hex" points={hexPoints(380, 160, 18)} />
      <polygon className="pc-hex inner" points={hexPoints(380, 160, 10)} />
      <text className="p-micro" x="380" y="112" textAnchor="middle">FOR AGENTS</text>
      <text className="p-micro peri" x="380" y="214" textAnchor="middle">HOSTED MCP</text>

      {agents.map((agent) => (
        <g key={agent.name}>
          <path className="pc-edge agent" d={`M 398,160 C 428,160 438,${agent.y} 466,${agent.y}`} />
          <polygon className="pc-hex" points={hexPoints(480, agent.y, 14)} />
          <circle className="pc-port agent" cx="466" cy={agent.y} r="2.2" />
          <text className="pc-agent-label" x="502" y={agent.y + 4}>{agent.name}</text>
        </g>
      ))}

      {/* ports — every edge docks somewhere addressable */}
      <circle className="pc-port" cx="230" cy="160" r="2.2" />
      <circle className="pc-port" cx="178" cy="160" r="2.2" />
      <circle className="pc-port agent" cx="274" cy="160" r="2.2" />
      <circle className="pc-port agent" cx="362" cy="160" r="2.2" />
      <circle className="pc-port agent" cx="398" cy="160" r="2.2" />
    </svg>
  );
}

// The drafting-plate lineage figure, carried over from the previous design and
// re-pigmented. The fourth row is still the point: trial_period_days has no
// producer and is drawn with nothing attached to it — a hollow port, an open
// stub, and the closing sentence hung off it on a leader line.
const LINEAGE_ROWS = [
  { field: 'body.customer', note: 'produced_by_api', linked: true },
  { field: 'body.items[].price', note: 'produced_by_api', linked: true },
  { field: 'body.trial_period_days', note: 'caller_supplied', linked: false },
];
const ROW_Y = [92, 146, 200];
const LIN_PRODUCERS = [
  { y: 40, method: 'POST', path: '/customers', field: 'response.id', chipW: 40 },
  { y: 152, method: 'GET', path: '/prices', field: 'response.data[].id', chipW: 36 },
];
const CONSUMER = { x: 452, y: 32, w: 296, h: 204 };

/** Register ticks just off each plate corner — the figure was placed, not screenshotted. */
function Ticks({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const g = 3;
  const l = 7;
  const d = [
    `M ${x - g},${y} h ${-l} M ${x},${y - g} v ${-l}`,
    `M ${x + w + g},${y} h ${l} M ${x + w},${y - g} v ${-l}`,
    `M ${x - g},${y + h} h ${-l} M ${x},${y + h + g} v ${l}`,
    `M ${x + w + g},${y + h} h ${l} M ${x + w},${y + h + g} v ${l}`,
  ].join(' ');
  return <path className="lin-tick" d={d} />;
}

export function LineagePoster() {
  return (
    <svg
      className="poster poster-lineage"
      viewBox="0 0 760 268"
      role="img"
      aria-label="Lineage: POST /customers' response id feeds POST /subscriptions' customer field, GET /prices' response id feeds its price field, and trial_period_days has no producer and is left unattached."
    >
      <defs>
        <pattern id="lin-dots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle className="p-dot" cx="1.2" cy="1.2" r="1.2" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="760" height="268" fill="url(#lin-dots)" />

      {LIN_PRODUCERS.map((p) => (
        <g key={p.path}>
          <rect className="lin-plate" x="8" y={p.y} width="240" height="76" rx="2" />
          <Ticks x={8} y={p.y} w={240} h={76} />
          <text className="lin-tag" x="10" y={p.y - 8}>PRODUCES</text>
          <rect
            className={p.method === 'GET' ? 'lin-chip get' : 'lin-chip'}
            x="22"
            y={p.y + 12}
            width={p.chipW}
            height="17"
            rx="2"
          />
          <text
            className={p.method === 'GET' ? 'lin-chip-text get' : 'lin-chip-text'}
            x={22 + p.chipW / 2}
            y={p.y + 24.5}
            textAnchor="middle"
          >
            {p.method}
          </text>
          <text className="lin-op" x={22 + p.chipW + 10} y={p.y + 25}>{p.path}</text>
          <line className="lin-divider" x1="22" y1={p.y + 36} x2="232" y2={p.y + 36} />
          <text className="lin-field" x="22" y={p.y + 58}>{p.field}</text>
          <circle className="lin-port" cx="248" cy={p.y + 54} r="3" />
        </g>
      ))}

      <g className="lin-edges">
        <path className="lin-edge" d="M 251,94 C 330,94 380,92 448,92" />
        <path className="lin-edge" d="M 251,206 C 330,206 380,146 448,146" />
        {/* the signal that produced each link, worn as a chip on the wire */}
        <rect className="lin-why-chip" x="281" y="84" width="138" height="17" rx="2" />
        <text className="lin-why" x="350" y="95.5" textAnchor="middle">foreign_key_name · high</text>
        <rect className="lin-why-chip" x="281" y="168" width="138" height="17" rx="2" />
        <text className="lin-why" x="350" y="179.5" textAnchor="middle">distinctive_name · high</text>
      </g>

      <g>
        <rect className="lin-plate consumer" x={CONSUMER.x} y={CONSUMER.y} width={CONSUMER.w} height={CONSUMER.h} rx="2" />
        <Ticks x={CONSUMER.x} y={CONSUMER.y} w={CONSUMER.w} h={CONSUMER.h} />
        <text className="lin-tag" x={CONSUMER.x + 2} y={CONSUMER.y - 8}>REQUIRES</text>
        <rect className="lin-chip" x="468" y="44" width="40" height="17" rx="2" />
        <text className="lin-chip-text" x="488" y="56.5" textAnchor="middle">POST</text>
        <text className="lin-op" x="518" y="57">/subscriptions</text>
        <line className="lin-divider" x1="468" y1="70" x2="732" y2="70" />

        {LINEAGE_ROWS.map((row, i) => (
          <g key={row.field}>
            <text className={row.linked ? 'lin-field' : 'lin-field open'} x="472" y={ROW_Y[i] + 4}>{row.field}</text>
            <text
              className={row.linked ? 'lin-origin' : 'lin-origin open'}
              x="732"
              y={ROW_Y[i] + 4}
              textAnchor="end"
            >
              {row.note}
            </text>
            {row.linked && <circle className="lin-port" cx={CONSUMER.x} cy={ROW_Y[i]} r="3" />}
          </g>
        ))}
        <line className="lin-row-rule" x1="468" y1="119" x2="732" y2="119" />
        <line className="lin-row-rule" x1="468" y1="173" x2="732" y2="173" />

        {/* the honest row — an absence, drawn as one: hollow port, open stub */}
        <circle className="lin-port open" cx={CONSUMER.x} cy={ROW_Y[2]} r="3.4" />
        <path className="lin-stub" d="M 446,200 L 408,200 M 408,194 L 408,206" />
        <text className="lin-why" x="412" y="188" textAnchor="middle">no producer</text>
      </g>

      <path className="lin-leader" d="M 408,206 L 452,244" />
      <text className="lin-none strong" x="460" y="248">nothing produces this.</text>
      <text className="lin-none" x="460" y="262">we say so, rather than guess.</text>
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
