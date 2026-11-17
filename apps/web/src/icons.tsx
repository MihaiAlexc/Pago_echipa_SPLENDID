/**
 * Iconițe SVG desenate pentru aplicație (stil „duotone”: albastru + accent galben, ca în Pago).
 * Toate sunt decorative (aria-hidden); textul de lângă ele spune ce fac.
 */
import type { ReactNode } from "react";

const B = "var(--blue)";
const Y = "var(--yellow)";
const L = "var(--blue-light)";

function Svg({ size = 24, children, vb = "0 0 24 24" }: { size?: number; children: ReactNode; vb?: string }) {
  return (
    <svg width={size} height={size} viewBox={vb} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/* ---------- bara de jos (stroke, culoarea vine din CSS: currentColor) ---------- */
export const IconHome = ({ size = 26 }) => (
  <Svg size={size}>
    <path d="M3.5 10.6 12 3.8l8.5 6.8V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z" fill="currentColor" />
  </Svg>
);
export const IconBills = ({ size = 26 }) => (
  <Svg size={size}>
    <path d="M5 3h14v18l-2.3-1.6L14.3 21 12 19.4 9.7 21l-2.4-1.6L5 21z" fill="currentColor" />
    <path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
  </Svg>
);
export const IconCarNav = ({ size = 26 }) => (
  <Svg size={size}>
    <path d="M4 11.5 6 6.5A2 2 0 0 1 7.9 5h8.2A2 2 0 0 1 18 6.5l2 5V18a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-1h-9v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" fill="currentColor" />
    <circle cx="7.5" cy="13.5" r="1.4" fill="#fff" /><circle cx="16.5" cy="13.5" r="1.4" fill="#fff" />
    <path d="M6.6 10.5 7.8 7.2h8.4l1.2 3.3z" fill="#fff" opacity=".85" />
  </Svg>
);
export const IconDots = ({ size = 26 }) => (
  <Svg size={size}>
    <circle cx="5" cy="12" r="2.3" fill="currentColor" /><circle cx="12" cy="12" r="2.3" fill="currentColor" /><circle cx="19" cy="12" r="2.3" fill="currentColor" />
  </Svg>
);

/* ---------- acțiuni ---------- */
export const IconMic = ({ size = 28 }) => (
  <Svg size={size}>
    <rect x="9" y="2.8" width="6" height="11.5" rx="3" fill="currentColor" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
  </Svg>
);
export const IconClose = ({ size = 22 }) => (
  <Svg size={size}><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></Svg>
);
export const IconSend = ({ size = 22 }) => (
  <Svg size={size}><path d="M4 12 20 4l-4 16-4-6.5z" fill="currentColor" /><path d="m12 13.5 8-9.5" stroke="#fff" strokeWidth="1.4" /></Svg>
);
export const IconChevron = ({ size = 20 }) => (
  <Svg size={size}><path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
);
export const IconPlus = ({ size = 20 }) => (
  <Svg size={size}><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></Svg>
);
export const IconSpeaker = ({ size = 18 }) => (
  <Svg size={size}>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
  </Svg>
);
export const IconStop = ({ size = 18 }) => (
  <Svg size={size}><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" /></Svg>
);
export const IconHistory = ({ size = 22 }) => (
  <Svg size={size}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
    <path d="M4 4.5v3.7h3.7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 8v4.3l2.8 1.8" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
  </Svg>
);
export const IconFingerprint = ({ size = 24 }) => (
  <Svg size={size}>
    <g stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round">
      <path d="M6.2 6.6A8 8 0 0 1 20 12v1.2" /><path d="M4.2 10.5A8 8 0 0 0 4 12.3v1.2" />
      <path d="M8 12a4 4 0 0 1 8 0v1.5a9 9 0 0 1-1.2 4.5" /><path d="M12 12v1.8a12 12 0 0 1-2.6 7" /><path d="M8 15.5a12 12 0 0 1-1.6 4" />
    </g>
  </Svg>
);
export const IconCheck = ({ size = 22 }) => (
  <Svg size={size}><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></Svg>
);

/* ---------- monede și ilustrații mici (duotone) ---------- */
export const CoinP = ({ size = 26 }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="10.5" fill={Y} /><circle cx="12" cy="12" r="8.3" fill="#FBD772" />
    <path d="M9.6 17V7.4h3.3a2.9 2.9 0 0 1 0 5.8H9.6M8 11.6h4.8" stroke="#C98A0B" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const IllBolt = ({ size = 30 }) => (
  <Svg size={size}><rect x="3" y="2" width="15" height="20" rx="3" fill={L} /><path d="M13.5 6 9 13h3.5l-1.5 6 5-8h-3.5z" fill={B} /><circle cx="18.5" cy="17.5" r="3.5" fill={Y} /></Svg>
);
export const IllFlame = ({ size = 30 }) => (
  <Svg size={size}><path d="M12 2.5c3 3.3 6 6.5 6 11a6 6 0 0 1-12 0c0-2.5 1.2-4 2.5-5.3.3 1.6 1 2.6 2 3.1 0-3 .5-6 1.5-8.8z" fill={B} /><path d="M12 12.5c1.4 1.4 2.5 2.6 2.5 4.2a2.5 2.5 0 0 1-5 0c0-1.5 1.1-2.8 2.5-4.2z" fill={Y} /></Svg>
);
export const IllDrop = ({ size = 30 }) => (
  <Svg size={size}><path d="M12 2.8s6.5 7.2 6.5 11.7a6.5 6.5 0 0 1-13 0C5.5 10 12 2.8 12 2.8z" fill={B} /><path d="M9 14.8a3 3 0 0 0 3 3" stroke={Y} strokeWidth="2" fill="none" strokeLinecap="round" /></Svg>
);
export const IllWifi = ({ size = 30 }) => (
  <Svg size={size}>
    <g stroke={B} strokeWidth="2.4" fill="none" strokeLinecap="round"><path d="M3 9.5a13 13 0 0 1 18 0" /><path d="M6.2 13a8.5 8.5 0 0 1 11.6 0" /></g>
    <path d="M9.4 16.4a3.8 3.8 0 0 1 5.2 0" stroke={Y} strokeWidth="2.4" fill="none" strokeLinecap="round" /><circle cx="12" cy="19.6" r="1.6" fill={Y} />
  </Svg>
);
export const IllPhone = ({ size = 30 }) => (
  <Svg size={size}><rect x="6" y="2" width="12" height="20" rx="3" fill={B} /><rect x="8" y="5" width="8" height="11" rx="1" fill={L} /><circle cx="12" cy="19" r="1.2" fill={Y} /></Svg>
);
export const IllShieldCar = ({ size = 30 }) => (
  <Svg size={size}>
    <path d="M3 13.5 4.6 9.3A1.8 1.8 0 0 1 6.3 8h7.4a1.8 1.8 0 0 1 1.7 1.3l1.6 4.2V19a.8.8 0 0 1-.8.8h-1.4a.8.8 0 0 1-.8-.8v-.8h-8V19a.8.8 0 0 1-.8.8H3.8A.8.8 0 0 1 3 19z" fill={B} />
    <path d="M17.5 2.5 22 4v3.6c0 3-2 4.8-4.5 5.9-2.5-1.1-4.5-2.9-4.5-5.9V4z" fill={Y} />
  </Svg>
);
export const IllRoad = ({ size = 30 }) => (
  <Svg size={size}>
    <path d="M9 3h2.2l-.6 18H6.4zM12.8 3H15l2.6 18h-4.2z" fill={B} /><rect x="4" y="6.2" width="16" height="2.6" rx="1.3" fill={Y} />
  </Svg>
);
export const IllGlobeSim = ({ size = 30 }) => (
  <Svg size={size}>
    <circle cx="10" cy="11" r="8" fill={L} /><path d="M2 11h16M10 3c2.5 2.5 2.5 13.5 0 16M10 3c-2.5 2.5-2.5 13.5 0 16" stroke={B} strokeWidth="1.4" fill="none" />
    <path d="M14 12h6.5l2 2v8H14z" fill={B} /><rect x="16" y="16" width="4.5" height="3.5" rx=".6" fill={Y} />
  </Svg>
);
export const IllPlane = ({ size = 30 }) => (
  <Svg size={size}>
    <path d="M2.5 13.2 20 5.5c1.4-.6 2.4 1 1.3 2L8.4 17.6l-3.3.4 1.3-2.6-3.9-2.2z" fill={B} />
    <path d="M17.2 13.5 21 15v3.2c0 2.2-1.6 3.6-3.8 4.4-2.2-.8-3.8-2.2-3.8-4.4V15z" fill={Y} />
  </Svg>
);
export const IllSparkle = ({ size = 30 }) => (
  <Svg size={size}>
    <path d="M10 2.5l1.9 5.6 5.6 1.9-5.6 1.9L10 17.5l-1.9-5.6L2.5 10l5.6-1.9z" fill={B} />
    <path d="M18 13l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" fill={Y} />
  </Svg>
);
export const IllCalendar = ({ size = 30 }) => (
  <Svg size={size}>
    <rect x="3" y="4.5" width="18" height="16.5" rx="3" fill={L} /><path d="M3 9.5h18V7.5a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3z" fill={B} />
    <path d="M8 2.8v3.4M16 2.8v3.4" stroke={B} strokeWidth="2" strokeLinecap="round" /><circle cx="15.5" cy="15.5" r="3.2" fill={Y} />
  </Svg>
);
export const IllVoice = ({ size = 30 }) => (
  <Svg size={size}>
    <rect x="8" y="2.5" width="8" height="13" rx="4" fill={B} /><path d="M5 11.5a7 7 0 0 0 14 0" stroke={B} strokeWidth="2" fill="none" strokeLinecap="round" />
    <path d="M12 18.5v3" stroke={Y} strokeWidth="2.4" strokeLinecap="round" />
  </Svg>
);
export const IllServer = ({ size = 30 }) => (
  <Svg size={size}>
    <rect x="3" y="3.5" width="18" height="7" rx="2.2" fill={B} /><rect x="3" y="13.5" width="18" height="7" rx="2.2" fill={L} />
    <circle cx="7" cy="7" r="1.3" fill={Y} /><circle cx="7" cy="17" r="1.3" fill={B} />
  </Svg>
);
export const IllRestart = ({ size = 30 }) => (
  <Svg size={size}>
    <path d="M5 12a7 7 0 1 0 2.1-5" stroke={B} strokeWidth="2.6" fill="none" strokeLinecap="round" />
    <path d="M4.5 3.8v4.6h4.6" stroke={B} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="12" r="2.6" fill={Y} />
  </Svg>
);
export const IllBrain = ({ size = 30 }) => (
  <Svg size={size}>
    <rect x="4" y="4" width="16" height="16" rx="4" fill={B} /><path d="M9 9h6v6H9z" fill={Y} />
    <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" stroke={B} strokeWidth="1.8" strokeLinecap="round" />
  </Svg>
);
export const IllShield = ({ size = 30 }) => (
  <Svg size={size}>
    <path d="M12 2.5 20 5v6.2c0 5-3.4 8.3-8 10.3-4.6-2-8-5.3-8-10.3V5z" fill={B} /><path d="m8.5 12 2.4 2.4 4.8-4.8" stroke={Y} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

/** Ilustrația potrivită pentru tipul de factură. */
export function BillIllustration({ category, size = 30 }: { category: string; size?: number }) {
  switch (category) {
    case "electricity": return <IllBolt size={size} />;
    case "gas": return <IllFlame size={size} />;
    case "water": return <IllDrop size={size} />;
    case "internet": return <IllWifi size={size} />;
    default: return <IllPhone size={size} />;
  }
}

/* ---------- Alte plăți (ilustrații mari, în stilul din Pago) ---------- */
const G = "#3cc35a";
export const IllTopUp = ({ size = 44 }) => (
  <Svg size={size}>
    <circle cx="8" cy="13.5" r="5" fill={Y} /><circle cx="8" cy="13.5" r="3" fill="#fbd772" />
    <path d="M15.5 3 20 9h-2.6v4h-3.8V9H11z" fill={B} />
    <path d="M15.5 14.5v1.6M15.5 18v1.4M15.5 21v1" stroke={B} strokeWidth="1.6" strokeLinecap="round" />
  </Svg>
);
export const IllDonate = ({ size = 44 }) => (
  <Svg size={size}>
    <path d="M12.5 11.2s-5-3-5-6.2a2.7 2.7 0 0 1 5-1.4 2.7 2.7 0 0 1 5 1.4c0 3.2-5 6.2-5 6.2z" fill={Y} />
    <path d="M3 17.5c2.5-2 5.5-2.6 8.5-1.4l4.4.4c1.1.1 1.1 1.7 0 1.8l-3.4.3 5.5-.6 3.5-2.2c.9-.6 1.9.6 1.1 1.4L18 20.5H8.5L5 21.5z" fill={L} />
    <rect x="1.5" y="16" width="3.4" height="6.5" rx="1" fill={B} transform="rotate(-18 3 19)" />
  </Svg>
);
export const IllGaming = ({ size = 44 }) => (
  <Svg size={size}>
    <path d="M3 13.5a4 4 0 0 1 4-4h6a4 4 0 0 1 0 8h-1l-1.5 1.5h-1L8 17.5H7a4 4 0 0 1-4-4z" fill={Y} />
    <path d="M6 13.5h3M7.5 12v3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /><circle cx="12.2" cy="13.5" r="1.1" fill="#fff" />
    <path d="M18.5 2.5 22.5 8h-2.3v3.5h-3.4V8h-2.3z" fill={B} />
    <path d="M18.5 13v1.4M18.5 16.2v1.3M18.5 19v1" stroke={B} strokeWidth="1.5" strokeLinecap="round" />
  </Svg>
);
export const IllTaxes = ({ size = 44 }) => (
  <Svg size={size}>
    <rect x="3" y="2.5" width="12" height="17" rx="2" fill={L} /><rect x="3" y="2.5" width="3" height="17" rx="1.5" fill="#9fb8f2" />
    <path d="M8 7h5M8 10h5M8 13h3" stroke={B} strokeWidth="1.4" strokeLinecap="round" />
    <rect x="11" y="11" width="11" height="8" rx="1.6" fill={Y} /><rect x="11" y="13" width="11" height="1.6" fill="#e0a92a" />
  </Svg>
);
export const IllSuggest = ({ size = 44 }) => (
  <Svg size={size}>
    <rect x="3" y="4" width="11" height="15" rx="2" fill={L} />
    <path d="M6 8.5h5M6 11.5h5M6 14.5h3" stroke={B} strokeWidth="1.4" strokeLinecap="round" />
    <path d="M18.5 7.5a3.5 3.5 0 0 0-2 6.4v1.4h4v-1.4a3.5 3.5 0 0 0-2-6.4z" fill={Y} /><rect x="16.7" y="16" width="3.6" height="1.8" rx=".6" fill={B} />
    <path d="M18.5 3.5V5M22.4 5.4l-1 1M14.6 5.4l1 1" stroke={Y} strokeWidth="1.3" strokeLinecap="round" />
  </Svg>
);
export const IllCredit = ({ size = 44 }) => (
  <Svg size={size}>
    <circle cx="13" cy="6.5" r="3.5" fill={Y} />
    <path d="M3.5 9.5h15a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill={L} />
    <path d="M3.5 9.5 5 8h14" stroke={B} strokeWidth="1.6" fill="none" strokeLinecap="round" />
    <rect x="15" y="13" width="5.5" height="3.6" rx="1" fill={B} /><circle cx="17" cy="14.8" r=".8" fill="#fff" />
  </Svg>
);
export const IllLoto = ({ size = 44 }) => (
  <Svg size={size}>
    <circle cx="8.5" cy="9" r="5" fill="#2fa84f" /><circle cx="15.5" cy="8" r="4.5" fill="#6fd38a" />
    <circle cx="16" cy="15" r="5" fill={G} /><circle cx="9.5" cy="16" r="4.6" fill="#4dbf68" />
  </Svg>
);
export const IllBridge = ({ size = 44 }) => (
  <Svg size={size}>
    <path d="M3 13h18" stroke={Y} strokeWidth="2.2" strokeLinecap="round" />
    <path d="M6.5 6v10M17.5 6v10" stroke={Y} strokeWidth="2.4" strokeLinecap="round" />
    <path d="M6.5 6c1.5 4 4 6.5 5.5 7 1.5-.5 4-3 5.5-7" stroke={Y} strokeWidth="1.4" fill="none" />
    <path d="M9 9.5v3.5M12 11v2M15 9.5v3.5" stroke={Y} strokeWidth="1.2" />
    <path d="M3 17.5c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0M3 20.5c1.5-1 3-1 4.5 0s3 1 4.5 0 3-1 4.5 0 3 1 4.5 0" stroke={B} strokeWidth="1.5" fill="none" strokeLinecap="round" />
  </Svg>
);
export const IllCarReport = ({ size = 44 }) => (
  <Svg size={size}>
    <path d="M9 9.5 10.3 6.6A1.5 1.5 0 0 1 11.7 5.7h6.6a1.5 1.5 0 0 1 1.4.9L21 9.5v4.5h-12z" fill={Y} />
    <path d="M2 13.5 3.6 9.8A1.8 1.8 0 0 1 5.3 8.6h7.4a1.8 1.8 0 0 1 1.7 1.2l1.6 3.7v4.8a.8.8 0 0 1-.8.8h-1.4a.8.8 0 0 1-.8-.8v-.7h-8v.7a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8z" fill={B} />
    <circle cx="5" cy="15.2" r="1.1" fill="#fff" /><circle cx="13" cy="15.2" r="1.1" fill="#fff" />
    <circle cx="18" cy="17.5" r="3.6" fill={G} /><path d="m16.4 17.5 1.1 1.1 2.1-2.2" stroke="#fff" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m20.6 20.1 1.9 1.9" stroke={B} strokeWidth="1.6" strokeLinecap="round" />
  </Svg>
);
export const IconGear = ({ size = 22 }) => (
  <Svg size={size}>
    <path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zm8.3 4.6-1.9.4a6.6 6.6 0 0 1-.7 1.7l1.1 1.6-1.8 1.8-1.6-1.1a6.6 6.6 0 0 1-1.7.7l-.4 1.9h-2.6l-.4-1.9a6.6 6.6 0 0 1-1.7-.7l-1.6 1.1-1.8-1.8 1.1-1.6a6.6 6.6 0 0 1-.7-1.7l-1.9-.4v-2.6l1.9-.4c.2-.6.4-1.2.7-1.7L4.6 6.9l1.8-1.8 1.6 1.1c.5-.3 1.1-.5 1.7-.7l.4-1.9h2.6l.4 1.9c.6.2 1.2.4 1.7.7l1.6-1.1 1.8 1.8-1.1 1.6c.3.5.5 1.1.7 1.7l1.9.4z" fill="currentColor" />
  </Svg>
);
export const IconGrid = ({ size = 26 }) => (
  <Svg size={size}>
    <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" fill="currentColor" /><rect x="13" y="3.5" width="7.5" height="7.5" rx="2" fill="currentColor" />
    <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" fill="currentColor" /><circle cx="16.75" cy="16.75" r="3.9" fill="currentColor" />
  </Svg>
);
