// The seal on the field report.
//
// This is the one place --stamp is allowed to appear, and it is deliberately
// the mark of the *instrument* rather than a claim about any particular API:
// it says how Spotcheck issues a finding ("by execution"), not that the API
// you are looking at passed. A stamp that appeared next to an unverified
// score would be exactly the laundering the product exists to prevent.
//
// Pure SVG and no interactivity, so it stays a server component. The landing
// animation lives in globals.css under .stamp, keyed off .js-landing.

const RING_OUTER = 88;
const RING_INNER = 78;
const ARC_TOP = 68; // text baseline radius, top
const ARC_BOTTOM = 66; // slightly tighter so the two runs feel optically equal

// Both arcs run left→right between the same two points. Sweep 1 traces over
// the top; sweep 0 traces under the bottom, which puts the glyph "up" vector
// toward the centre — the way a real rubber stamp sets its lower run.
const TOP_ARC = `M ${100 - ARC_TOP},100 A ${ARC_TOP},${ARC_TOP} 0 0 1 ${100 + ARC_TOP},100`;
const BOTTOM_ARC = `M ${100 - ARC_BOTTOM},100 A ${ARC_BOTTOM},${ARC_BOTTOM} 0 0 0 ${100 + ARC_BOTTOM},100`;

export default function VerificationStamp({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`stamp ${className}`.trim()}
      viewBox="0 0 200 200"
      role="img"
      aria-label="Spotcheck seal: findings verified by execution, not by reading the spec"
    >
      <defs>
        <path id="stamp-arc-top" d={TOP_ARC} fill="none" />
        <path id="stamp-arc-bottom" d={BOTTOM_ARC} fill="none" />
        {/* Roughens every edge just enough to read as ink pressed into stock
            rather than a vector circle. Static, so it costs one rasterise. */}
        <filter id="stamp-ink" x="-12%" y="-12%" width="124%" height="124%">
          <feTurbulence type="fractalNoise" baseFrequency="0.62" numOctaves="4" seed="7" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="2.1" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>

      <g filter="url(#stamp-ink)">
        <circle className="stamp-ring" cx="100" cy="100" r={RING_OUTER} />
        <circle className="stamp-ring thin" cx="100" cy="100" r={RING_INNER} />

        <text className="stamp-arc">
          <textPath href="#stamp-arc-top" startOffset="50%" textAnchor="middle">
            SPOTCHECK · FIELD REPORT
          </textPath>
        </text>
        <text className="stamp-arc">
          <textPath href="#stamp-arc-bottom" startOffset="50%" textAnchor="middle">
            NOT BY READING THE SPEC
          </textPath>
        </text>

        {/* centre block */}
        <path className="stamp-check" d="M 78,99 l 12,12 l 22,-25" />
        <text className="stamp-word" x="100" y="132" textAnchor="middle">
          VERIFIED
        </text>
        <line className="stamp-rule" x1="72" y1="142" x2="128" y2="142" />
        <text className="stamp-sub" x="100" y="156" textAnchor="middle">
          BY EXECUTION
        </text>
      </g>
    </svg>
  );
}
