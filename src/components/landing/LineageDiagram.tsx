// The lineage graph, drawn as a drafting plate.
//
// Deliberately NOT an .inst panel. The instrument-panel treatment is reserved
// for things that involved a live request; lineage is derived from the
// document itself, so it belongs on the paper, in prussian, as a technical
// drawing. Keeping that line sharp is what stops the dark-panel device from
// decaying into "the bits we thought looked cool".
//
// The fourth row is the point of the whole figure: trial_period_days has no
// producer and is drawn with nothing attached to it. An engine that wanted a
// good screenshot would have joined it to something.
//
// Pure SVG, no interactivity, so it stays a server component. The draw-on
// animation keys off .reveal.in, which LandingEffects adds on intersection.

type Row = { field: string; note: string; linked: boolean };

const CONSUMER_ROWS: Row[] = [
  { field: 'body.customer', note: 'produced_by_api', linked: true },
  { field: 'body.items[].price', note: 'produced_by_api', linked: true },
  { field: 'body.trial_period_days', note: 'caller_supplied', linked: false },
];

const ROW_Y = [92, 140, 188];
const BOX = { w: 236, h: 72 };
const CONSUMER = { x: 452, y: 44, w: 292, h: 188 };

export default function LineageDiagram() {
  return (
    <svg
      className="lineage-fig"
      viewBox="0 0 760 268"
      role="img"
      aria-label="Lineage: create_customer's response id feeds create_subscription's customer field, list_prices' response id feeds its price field, and trial_period_days has no producer and is left unattached."
    >
      {/* ---- producers ---- */}
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

      {/* ---- edges: drawn, with the signals that carried them ---- */}
      <g className="lin-edges">
        <path className="lin-edge" pathLength={1} d="M 244,82 C 330,82 372,92 452,92" />
        <text className="lin-why" x="348" y="76" textAnchor="middle">foreign_key_name · high</text>

        <path className="lin-edge" pathLength={1} d="M 244,186 C 330,186 372,140 452,140" />
        <text className="lin-why" x="348" y="176" textAnchor="middle">distinctive_name · high</text>
      </g>

      {/* ---- consumer ---- */}
      <g className="lin-node consumer">
        <rect x={CONSUMER.x} y={CONSUMER.y} rx="2" width={CONSUMER.w} height={CONSUMER.h} />
        <text className="lin-op" x={CONSUMER.x + 16} y={CONSUMER.y + 26}>POST /subscriptions</text>
        <text className="lin-tag" x={CONSUMER.x + 16} y={CONSUMER.y + 44}>REQUIRES</text>
        {CONSUMER_ROWS.map((row, i) => (
          <g key={row.field}>
            <text className="lin-field" x={CONSUMER.x + 16} y={ROW_Y[i] + 4}>
              {row.field}
            </text>
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
