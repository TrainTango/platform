import { useState, useEffect, useRef, useCallback } from "react";

const API_BASE = "/api";
const REFRESH_INTERVAL = 30000;

// ── Seating Guidance (tiered by confidence) ──
const COACH_GUIDANCE = {
  "LNER": { confidence: "high", coaches: "C", tip: "Coach C is always the unreserved coach on LNER. It's towards the north end on 9/10-car Azumas, or mid-train on 5-car services.", cardLabel: "Unreserved: C" },
  "Avanti West Coast": { confidence: "hint", coaches: "C", tip: "Coach C is often unreserved. On 11-car Pendolinos, Coach U may also be unreserved. Coach G on refurbished trains is also unreserved. This can vary — check platform displays.", cardLabel: "Often unreserved: C" },
  "CrossCountry": { confidence: "hint", coaches: "B or D", tip: "On 5 or 9-coach trains, Coach B is usually unreserved. On 4 or 8-coach trains, some seats in Coach D are unreserved. This changed in June 2024 — check platform displays.", cardLabel: "Often unreserved: B" },
  "Great Western Railway": { confidence: "hint", coaches: "G", tip: "Coach G is usually unreserved on London services. Non-London services are fully unreserved. This can vary — check platform displays.", cardLabel: "Often unreserved: G" },
  "East Midlands Railway": { confidence: "hint", coaches: "D", tip: "Coach D is usually unreserved on London services. Non-London services and Corby 'Connect' services are fully unreserved.", cardLabel: "Often unreserved: D" },
  "Hull Trains": { confidence: "high", coaches: "A", tip: "Coach A is always the unreserved coach on Hull Trains.", cardLabel: "Unreserved: A" },
  "TransPennine Express": { confidence: "hint", coaches: "D", tip: "Coach D is usually unreserved on Nova trains. On Class 185 trains, some seats in Coaches A and B are unreserved. This can vary.", cardLabel: "Often unreserved: D" },
  "Grand Central": { confidence: "hint", coaches: "B", tip: "Part of Coach B is usually unreserved on Sunderland services. On Bradford services, unreserved seats are spread throughout.", cardLabel: "Partially unreserved: B" },
};

const NO_RESERVATION_OPERATORS = new Set([
  "c2c", "Chiltern Railways", "Elizabeth line", "Gatwick Express",
  "Great Northern", "Greater Anglia", "Heathrow Express",
  "London Northwestern Railway", "London Overground", "Merseyrail",
  "Northern", "South Western Railway", "Southeastern", "Southern",
  "Stansted Express", "Thameslink", "Transport for Wales",
  "West Midlands Railway",
]);

const COMPULSORY_RESERVATION = new Set(["Caledonian Sleeper"]);

const LUMO_GUIDANCE = { confidence: "hint", tip: "Lumo has very limited unreserved seats, marked with a green light. There is no dedicated unreserved coach.", cardLabel: "Limited unreserved" };

// ── Recent Stations ──
function getRecent() {
  try { const r = JSON.parse(localStorage.getItem("platform_recent")); return Array.isArray(r) ? r.slice(0, 3) : []; }
  catch { return []; }
}
function saveRecent(station) {
  try {
    let r = getRecent().filter(s => s.code !== station.code);
    r.unshift(station);
    localStorage.setItem("platform_recent", JSON.stringify(r.slice(0, 3)));
  } catch {}
}

// ── API ──
async function fetchStations() {
  const r = await fetch(`${API_BASE}/stations`);
  if (!r.ok) throw new Error("Failed to fetch stations");
  const data = await r.json();
  if (data.locations) {
    return data.locations
      .filter(l => l.shortCodes && l.shortCodes.length > 0)
      .map(l => ({ name: l.description, code: l.shortCodes[0] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return data;
}

async function fetchDepartures(code) {
  const r = await fetch(`${API_BASE}/departures?code=${code}`);
  if (!r.ok) throw new Error("Failed to fetch departures");
  const data = await r.json();
  // Filter to departures only — services with a departure object are leaving
  if (data.services) {
    data.services = data.services.filter(svc => svc.temporalData?.departure);
  } else {
    data.services = [];
  }
  return data;
}

// ── Helpers ──
function fmtTime(iso) {
  if (!iso) return "--:--";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function minsUntil(iso) {
  if (!iso) return null;
  const diff = Math.round((new Date(iso) - new Date()) / 60000);
  return diff < 0 ? null : diff;
}

function relativeTime(date) {
  if (!date) return "";
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 5) return "Just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function getStatus(svc) {
  const dep = svc.temporalData?.departure;
  if (!dep) return { key: "on-time", label: "On time" };
  if (dep.isCancelled) return { key: "cancelled", label: "Cancelled" };
  const lat = dep.realtimeAdvertisedLateness || dep.realtimeInternalLateness;
  if (lat && lat > 0) return { key: "delayed", label: `+${lat} min` };
  return { key: "on-time", label: "On time" };
}

function getPlatform(svc) {
  const dep = svc.temporalData?.departure;
  const plat = svc.locationMetadata?.platform;
  if (dep?.isCancelled) return { text: "N/A", tier: "cancelled", label: "Cancelled" };
  if (!plat) return { text: "\u2014", tier: "unknown", label: "Unknown" };
  // actual = confirmed by signalling
  if (plat.actual) {
    const changed = plat.planned && plat.actual !== plat.planned;
    if (changed) return { text: plat.actual, tier: "changed", label: "Changed" };
    return { text: plat.actual, tier: "confirmed", label: "Confirmed" };
  }
  // forecast = expected but not yet confirmed
  if (plat.forecast) return { text: plat.forecast, tier: "expected", label: "Expected" };
  // planned = timetabled only
  if (plat.planned) return { text: plat.planned, tier: "expected", label: "Expected" };
  return { text: "\u2014", tier: "unknown", label: "Unknown" };
}

function getEffectiveTime(svc) {
  const dep = svc.temporalData?.departure;
  return dep?.realtimeForecast || dep?.realtimeActual || dep?.scheduleAdvertised;
}
function getScheduledTime(svc) { return svc.temporalData?.departure?.scheduleAdvertised; }
function getDestination(svc) { return svc.destination?.[0]?.location?.description || "Unknown"; }
function getOperator(svc) { return svc.scheduleMetadata?.operator?.name || ""; }
function nowHHMM() { return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }); }
function svcKey(svc) { return `${getDestination(svc)}-${getScheduledTime(svc)}`; }

// ── Styles ──
function getCSS(dark) {
  const t = dark ? {
    bg:"#090913",bgCard:"#101020",bgCardHover:"#141428",bgInput:"#16162a",
    text:"#f1f5f9",textMuted:"#94a3b8",textDim:"#6b7280",
    border:"#1e1e35",borderLight:"#252542",headerBg:"rgba(9,9,19,.92)",shadow:"rgba(0,0,0,.3)"
  } : {
    bg:"#f3f4f6",bgCard:"#ffffff",bgCardHover:"#f9fafb",bgInput:"#e5e7eb",
    text:"#111827",textMuted:"#4b5563",textDim:"#9ca3af",
    border:"#d1d5db",borderLight:"#e5e7eb",headerBg:"rgba(243,244,246,.92)",shadow:"rgba(0,0,0,.08)"
  };

  return `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:${t.bg};--bg-card:${t.bgCard};--bg-card-hover:${t.bgCardHover};--bg-input:${t.bgInput};
    --accent:#6366f1;--accent-dim:rgba(99,102,241,0.1);
    --amber:#f59e0b;--green:#10b981;--red:#ef4444;--orange:#f97316;
    --text:${t.text};--text-muted:${t.textMuted};--text-dim:${t.textDim};
    --border:${t.border};--border-light:${t.borderLight};--header-bg:${t.headerBg};--shadow:${t.shadow};
  }
  body,#root{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;transition:background .3s,color .3s}
  .app{max-width:480px;margin:0 auto;min-height:100vh;position:relative}
  @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

  .search-screen{display:flex;flex-direction:column;align-items:center;padding:0 20px;padding-top:10vh;min-height:100vh}
  .logo{font-size:44px;font-weight:900;letter-spacing:-2px;background:linear-gradient(135deg,#6366f1,#818cf8,#a5b4fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:2px}
  .tagline{color:var(--text-dim);font-size:14px;font-weight:500;margin-bottom:24px;letter-spacing:.3px}
  .search-wrap{width:100%;position:relative}
  .search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--text-dim);pointer-events:none}
  .search-input{width:100%;padding:16px 16px 16px 48px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:14px;color:var(--text);font-size:16px;font-family:inherit;outline:none;transition:border-color .2s,box-shadow .2s}
  .search-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.15)}
  .search-input::placeholder{color:var(--text-dim)}
  .theme-toggle{position:absolute;top:20px;right:20px;background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;transition:border-color .2s}
  .theme-toggle:hover{border-color:var(--accent)}

  .recent-section{width:100%;margin-top:20px}
  .recent-label{font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
  .recent-list{display:flex;flex-direction:column;gap:6px}
  .recent-btn{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;cursor:pointer;transition:background .15s;min-height:48px}
  .recent-btn:hover{background:var(--bg-card-hover)}
  .recent-name{font-size:14px;font-weight:600;color:var(--text)}
  .recent-code{font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:3px 8px;border-radius:6px}

  .dropdown{position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;z-index:50;max-height:320px;overflow-y:auto;box-shadow:0 12px 40px var(--shadow)}
  .dropdown-item{padding:14px 16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:background .15s;border-bottom:1px solid var(--border);min-height:48px}
  .dropdown-item:last-child{border-bottom:none}
  .dropdown-item:hover{background:var(--accent-dim)}
  .dropdown-name{font-size:14px;font-weight:500}
  .dropdown-code{font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:3px 8px;border-radius:6px}

  .board-screen{display:flex;flex-direction:column;min-height:100vh}
  .board-header{position:sticky;top:0;z-index:40;background:var(--header-bg);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);padding:12px 16px 0;border-bottom:1px solid var(--border)}
  .header-row1{display:flex;align-items:center;gap:8px}
  .back-btn{background:none;border:none;color:var(--text-muted);cursor:pointer;padding:12px;border-radius:10px;display:flex;align-items:center;min-width:44px;min-height:44px;justify-content:center;transition:all .2s}
  .back-btn:hover{color:var(--text);background:var(--accent-dim)}
  .station-name{font-size:17px;font-weight:800;letter-spacing:-.5px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .header-clock{font-size:17px;font-weight:800;color:var(--accent);font-variant-numeric:tabular-nums}
  .header-row2{display:flex;align-items:center;justify-content:space-between;padding-left:44px;margin-top:3px}
  .header-sub{font-size:11px;color:var(--text-dim)}
  .header-actions{display:flex;align-items:center;gap:6px}
  .live-pill{display:flex;align-items:center;gap:5px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);padding:4px 12px;border-radius:14px;cursor:pointer;font-size:11px;font-weight:700;color:var(--green);letter-spacing:.5px;text-transform:uppercase;min-height:32px}
  .live-pill:hover{background:rgba(16,185,129,.15)}
  .live-dot{width:6px;height:6px;background:var(--green);border-radius:50%;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .theme-btn-sm{background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:6px;cursor:pointer;display:flex;align-items:center;color:var(--text-muted);min-width:32px;min-height:32px;justify-content:center}
  .refresh-bar{height:3px;background:var(--border);overflow:hidden}
  .refresh-fill{height:100%;background:var(--accent);transition:width 1s linear}

  .toast-wrap{position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:100;display:flex;flex-direction:column;gap:6px;max-width:460px;width:calc(100% - 32px)}
  .toast{background:var(--orange);color:#fff;padding:12px 16px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;gap:8px;animation:toastIn .3s ease-out}
  @keyframes toastIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
  .toast-icon{font-size:16px;flex-shrink:0}
  .toast-close{background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;padding:4px;margin-left:auto;font-size:16px;line-height:1}

  .card-list{padding:6px 10px 24px;display:flex;flex-direction:column;gap:6px}
  .dep-card{background:var(--bg-card);border-radius:12px;border-left:3.5px solid;display:grid;grid-template-columns:56px 1fr auto;gap:4px 10px;padding:12px 12px 12px 12px;align-items:center;cursor:pointer;transition:background .15s}
  .dep-card:hover{background:var(--bg-card-hover)}
  .dep-card.on-time{border-left-color:var(--green)}
  .dep-card.delayed{border-left-color:var(--amber)}
  .dep-card.cancelled{border-left-color:var(--red);opacity:.55}

  .countdown-col{display:flex;flex-direction:column;align-items:center;min-width:48px}
  .countdown-num{font-size:26px;font-weight:900;letter-spacing:-1px;line-height:1;font-variant-numeric:tabular-nums}
  .countdown-due{font-size:18px;font-weight:900;color:var(--green)}
  .countdown-unit{font-size:11px;font-weight:600;color:var(--text-dim);margin-top:1px}
  .countdown-time{font-size:11px;font-weight:600;color:var(--text-dim);font-variant-numeric:tabular-nums;margin-top:2px}

  .info-col{display:flex;flex-direction:column;gap:3px;min-width:0}
  .dest-name{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
  .meta-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  .status-badge{font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px;letter-spacing:.2px;text-transform:uppercase}
  .status-on-time{background:rgba(16,185,129,.1);color:var(--green)}
  .status-delayed{background:rgba(245,158,11,.1);color:var(--amber)}
  .status-cancelled{background:rgba(239,68,68,.1);color:var(--red)}
  .coach-pill{font-size:11px;font-weight:600;color:var(--accent);background:var(--accent-dim);padding:2px 7px;border-radius:5px}
  .coach-pill-hint{color:var(--text-muted);background:var(--bg-input);font-style:italic}
  .coach-pill-free{color:var(--green);background:rgba(16,185,129,.1)}
  .operator-name{font-size:11px;color:var(--text-dim)}

  .plat-col{display:flex;flex-direction:column;align-items:center;gap:2px;justify-self:end}
  .plat-badge{min-width:54px;height:54px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:22px;letter-spacing:-.5px;padding:0 6px;font-variant-numeric:tabular-nums;position:relative}
  .plat-badge-icon{position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;border:2px solid var(--bg)}
  .plat-icon-confirmed{background:#2d6a4f;color:#e8f5ec}
  .plat-icon-changed{background:#8b5a3c;color:#fde8d8}
  .plat-icon-expected{background:var(--border-light);color:var(--text-muted)}
  .plat-confirmed{background:#2d6a4f;color:#e8f5ec;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .plat-changed{background:#8b5a3c;color:#fde8d8;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .plat-expected{background:transparent;color:var(--text-muted);border:2px solid var(--border-light);font-size:20px}
  .plat-unknown{background:var(--bg-input);color:var(--text-dim);border:2px dashed var(--border-light);font-size:18px}
  .plat-cancelled{background:var(--bg-input);color:var(--text-dim);border:1.5px solid var(--border);font-size:12px;font-weight:700;opacity:.6}
  .plat-status{font-size:11px;font-weight:700;letter-spacing:.2px;text-align:center}
  .plat-status-confirmed{color:var(--text-muted)}
  .plat-status-changed{color:var(--text-muted)}
  .plat-status-expected{color:var(--text-dim)}
  .plat-status-unknown{color:var(--text-dim)}

  .expanded-area{grid-column:1/-1;padding-top:10px;margin-top:6px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px}
  .tip-card{border-radius:8px;padding:10px 12px;display:flex;gap:8px;align-items:flex-start}
  .tip-platform{background:rgba(45,106,79,.06);border:1px solid rgba(45,106,79,.15)}
  .tip-platform-changed{background:rgba(139,90,60,.08);border:1px solid rgba(139,90,60,.2)}
  .tip-coach{background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.12)}
  .tip-hint{background:var(--bg-input);border:1px solid var(--border)}
  .tip-free{background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.12)}
  .tip-icon{font-size:16px;flex-shrink:0;margin-top:1px}
  .tip-content{display:flex;flex-direction:column;gap:2px}
  .tip-title{font-size:12px;font-weight:700;color:var(--text)}
  .tip-desc{font-size:12px;color:var(--text-muted);line-height:1.4}
  .tip-hint .tip-title{color:var(--text-muted)}
  .tip-hint .tip-desc{font-style:italic}

  .detail-row{display:flex;gap:16px;flex-wrap:wrap}
  .detail-item{display:flex;flex-direction:column;gap:1px}
  .detail-label{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
  .detail-value{font-size:12px;font-weight:600;color:var(--text-muted)}
  .cancel-reason{font-size:12px;color:var(--red);font-weight:500;font-style:italic}

  .legend-bar{display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 10px;flex-wrap:wrap}
  .legend-item{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim);font-weight:500}
  .legend-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
  .legend-dot-confirmed{background:#2d6a4f}
  .legend-dot-changed{background:#8b5a3c}
  .legend-dot-expected{border:2px solid var(--border-light);background:transparent}
  .legend-dot-unknown{border:2px dashed var(--border-light);background:transparent}

  .loading-wrap,.error-wrap,.empty-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;text-align:center}
  .spinner{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;margin-bottom:14px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .error-msg{color:var(--red);font-weight:600;margin-bottom:16px;font-size:14px}
  .retry-btn{background:var(--accent);color:white;border:none;padding:10px 24px;border-radius:10px;font-weight:600;font-size:14px;font-family:inherit;cursor:pointer}
  .empty-icon{font-size:32px;margin-bottom:10px;opacity:.4}
  .empty-text{color:var(--text-muted);font-size:13px}

  .donate-section{display:flex;align-items:center;justify-content:center;gap:6px;padding:16px 20px;margin-top:12px;cursor:pointer;opacity:.6;transition:opacity .2s}
  .donate-section:hover{opacity:1}
  .donate-text{font-size:12px;color:var(--text-dim)}
  .donate-text strong{color:var(--text-muted)}
  `;
}

// ── Icons ──
const SearchIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const BackIcon = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>;
const SunIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
const MoonIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>;

function DepartureCard({ svc }) {
  const [expanded, setExpanded] = useState(false);
  const status = getStatus(svc);
  const plat = getPlatform(svc);
  const dest = getDestination(svc);
  const operator = getOperator(svc);
  const scheduled = getScheduledTime(svc);
  const effective = getEffectiveTime(svc);
  const mins = minsUntil(effective);
  const isDelayed = status.key === "delayed";
  const vehicles = svc.locationMetadata?.numberOfVehicles;
  const guidance = COACH_GUIDANCE[operator];
  const isNoReservation = NO_RESERVATION_OPERATORS.has(operator);
  const isCompulsory = COMPULSORY_RESERVATION.has(operator);
  const isLumo = operator === "Lumo";
  const reasons = svc.reasons;
  const cancelReason = reasons?.find(r => r.type === "CANCEL")?.shortText || reasons?.find(r => r.type === "DELAY")?.shortText;

  return (
    <div className={`dep-card ${status.key}`} role="button" tabIndex={0} aria-expanded={expanded}
      onClick={() => setExpanded(e => !e)} onKeyDown={e => e.key === "Enter" && setExpanded(x => !x)}>
      <div className="countdown-col">
        {mins !== null && mins > 0 ? (
          <><span className="countdown-num">{mins}</span><span className="countdown-unit">min</span></>
        ) : mins === 0 ? (
          <span className="countdown-due">Due</span>
        ) : (
          <span className="countdown-num" style={{fontSize:16}}>--</span>
        )}
        <span className="countdown-time">{fmtTime(scheduled)}</span>
      </div>

      <div className="info-col">
        <span className="dest-name">{dest}</span>
        <div className="meta-row">
          <span className={`status-badge status-${status.key}`}>{status.label}</span>
          {status.key !== "cancelled" && guidance && (
            <span className={`coach-pill ${guidance.confidence === "hint" ? "coach-pill-hint" : ""}`}>{"\uD83D\uDCBA"} {guidance.cardLabel}</span>
          )}
          {status.key !== "cancelled" && isNoReservation && (
            <span className="coach-pill coach-pill-free">{"\u2705"} Sit anywhere</span>
          )}
          {status.key !== "cancelled" && isLumo && (
            <span className="coach-pill coach-pill-hint">{"\uD83D\uDCBA"} {LUMO_GUIDANCE.cardLabel}</span>
          )}
          <span className="operator-name">{operator}{vehicles ? ` \u00B7 ${vehicles} coaches` : ""}</span>
        </div>
      </div>

      <div className="plat-col">
        <div className={`plat-badge plat-${plat.tier}`}>
          {plat.text}
          {plat.tier === "confirmed" && <span className="plat-badge-icon plat-icon-confirmed">{"\u2713"}</span>}
          {plat.tier === "changed" && <span className="plat-badge-icon plat-icon-changed">!</span>}
          {plat.tier === "expected" && <span className="plat-badge-icon plat-icon-expected">?</span>}
        </div>
        <span className={`plat-status plat-status-${plat.tier}`}>{plat.label}</span>
      </div>

      {expanded && (
        <div className="expanded-area">
          {plat.tier === "expected" && (
            <div className="tip-card tip-platform">
              <span className="tip-icon">{"\uD83D\uDFE1"}</span>
              <div className="tip-content">
                <span className="tip-title">Platform {plat.text} is expected</span>
                <span className="tip-desc">Based on the timetable. We'll update this to confirmed once live signalling data comes through — stay on this page.</span>
              </div>
            </div>
          )}
          {plat.tier === "confirmed" && (
            <div className="tip-card tip-platform">
              <span className="tip-icon">{"\u2705"}</span>
              <div className="tip-content">
                <span className="tip-title">Platform {plat.text} is confirmed</span>
                <span className="tip-desc">Live signalling data — head there now.</span>
              </div>
            </div>
          )}
          {plat.tier === "changed" && (
            <div className="tip-card tip-platform-changed">
              <span className="tip-icon">{"\u26A0\uFE0F"}</span>
              <div className="tip-content">
                <span className="tip-title">Platform changed to {plat.text}</span>
                <span className="tip-desc">Different from the timetable — we've confirmed the new platform via live data. Head to platform {plat.text}.</span>
              </div>
            </div>
          )}

          {status.key !== "cancelled" && guidance && (
            <div className={`tip-card ${guidance.confidence === "high" ? "tip-coach" : "tip-hint"}`}>
              <span className="tip-icon">{guidance.confidence === "high" ? "\uD83D\uDCBA" : "\uD83D\uDCA1"}</span>
              <div className="tip-content">
                <span className="tip-title">{guidance.confidence === "high" ? `Unreserved: Coach ${guidance.coaches}` : `Seating hint: Coach ${guidance.coaches}`}</span>
                <span className="tip-desc">{guidance.tip}</span>
              </div>
            </div>
          )}
          {status.key !== "cancelled" && isNoReservation && (
            <div className="tip-card tip-free">
              <span className="tip-icon">{"\u2705"}</span>
              <div className="tip-content">
                <span className="tip-title">No reservations on {operator}</span>
                <span className="tip-desc">This operator doesn't use seat reservations. Every seat is unreserved — just board and sit anywhere.</span>
              </div>
            </div>
          )}
          {status.key !== "cancelled" && isLumo && (
            <div className="tip-card tip-hint">
              <span className="tip-icon">{"\uD83D\uDCA1"}</span>
              <div className="tip-content">
                <span className="tip-title">Limited unreserved seats</span>
                <span className="tip-desc">{LUMO_GUIDANCE.tip}</span>
              </div>
            </div>
          )}
          {status.key !== "cancelled" && isCompulsory && (
            <div className="tip-card tip-hint">
              <span className="tip-icon">{"\u26A0\uFE0F"}</span>
              <div className="tip-content">
                <span className="tip-title">Reservation required</span>
                <span className="tip-desc">This operator requires a reservation for all seats. Check your booking confirmation for your coach and seat number.</span>
              </div>
            </div>
          )}

          {cancelReason && <div className="cancel-reason">Reason: {cancelReason}</div>}

          <div className="detail-row">
            <div className="detail-item">
              <span className="detail-label">Operator</span>
              <span className="detail-value">{operator}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">Scheduled</span>
              <span className="detail-value">{fmtTime(scheduled)}</span>
            </div>
            {isDelayed && (
              <div className="detail-item">
                <span className="detail-label">Expected</span>
                <span className="detail-value" style={{color:"var(--amber)"}}>{fmtTime(effective)}</span>
              </div>
            )}
            {vehicles && (
              <div className="detail-item">
                <span className="detail-label">Coaches</span>
                <span className="detail-value">{vehicles}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CompactLegend() {
  return (
    <div className="legend-bar" role="legend" aria-label="Platform badge legend">
      <div className="legend-item"><div className="legend-dot legend-dot-confirmed"/> Confirmed</div>
      <div className="legend-item"><div className="legend-dot legend-dot-changed"/> Changed</div>
      <div className="legend-item"><div className="legend-dot legend-dot-expected"/> Expected</div>
      <div className="legend-item"><div className="legend-dot legend-dot-unknown"/> Unknown</div>
    </div>
  );
}

export default function App() {
  const [dark, setDark] = useState(() => {
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; }
  });
  const [screen, setScreen] = useState("search");
  const [stations, setStations] = useState([]);
  const [query, setQuery] = useState("");
  const [filtered, setFiltered] = useState([]);
  const [showDrop, setShowDrop] = useState(false);
  const [station, setStation] = useState(null);
  const [deps, setDeps] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpDate, setLastUpDate] = useState(null);
  const [lastUpText, setLastUpText] = useState("");
  const [clock, setClock] = useState(nowHHMM());
  const [refreshPct, setRefreshPct] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [recent, setRecent] = useState(getRecent);
  const prevDepsRef = useRef(null);
  const timerRef = useRef(null);
  const clockRef = useRef(null);
  const pctRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { fetchStations().then(setStations).catch(err => console.error("Stations:", err)); }, []);

  useEffect(() => {
    clockRef.current = setInterval(() => {
      setClock(nowHHMM());
      if (lastUpDate) setLastUpText(relativeTime(lastUpDate));
    }, 1000);
    return () => clearInterval(clockRef.current);
  }, [lastUpDate]);

  useEffect(() => {
    if (!query.trim()) { setFiltered([]); setShowDrop(false); return; }
    const q = query.toLowerCase();
    setFiltered(stations.filter(s => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)).slice(0, 8));
    setShowDrop(true);
  }, [query, stations]);

  const detectChanges = useCallback((newServices) => {
    if (!prevDepsRef.current) { prevDepsRef.current = newServices; return; }
    const oldMap = {};
    prevDepsRef.current.forEach(s => { oldMap[svcKey(s)] = getPlatform(s); });
    const newToasts = [];
    newServices.forEach(s => {
      const key = svcKey(s);
      const oldP = oldMap[key];
      const newP = getPlatform(s);
      if (oldP && newP.text !== oldP.text && newP.tier !== "unknown" && newP.tier !== "cancelled") {
        newToasts.push({ id: Date.now() + Math.random(), dest: getDestination(s), plat: newP.text, tier: newP.tier });
        try { navigator.vibrate?.(200); } catch {}
      }
      if (oldP && oldP.tier === "expected" && newP.tier === "confirmed" && oldP.text === newP.text) {
        newToasts.push({ id: Date.now() + Math.random(), dest: getDestination(s), plat: newP.text, tier: "now-confirmed" });
        try { navigator.vibrate?.(100); } catch {}
      }
    });
    if (newToasts.length) setToasts(t => [...t, ...newToasts]);
    prevDepsRef.current = newServices;
  }, []);

  const loadDepartures = useCallback(async (code) => {
    setLoading(true); setError(null);
    try {
      const data = await fetchDepartures(code);
      const svcs = data.services || [];
      detectChanges(svcs);
      setDeps(svcs);
      const now = new Date();
      setLastUpDate(now);
      setLastUpText(relativeTime(now));
      setRefreshPct(0);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [detectChanges]);

  const selectStation = useCallback((s) => {
    setStation(s); setQuery(""); setShowDrop(false);
    saveRecent(s); setRecent(getRecent());
    prevDepsRef.current = null;
    setScreen("board"); loadDepartures(s.code);
  }, [loadDepartures]);

  useEffect(() => {
    if (screen !== "board" || !station) return;
    let elapsed = 0;
    pctRef.current = setInterval(() => { elapsed += 1000; setRefreshPct(Math.min((elapsed / REFRESH_INTERVAL) * 100, 100)); }, 1000);
    timerRef.current = setInterval(() => { elapsed = 0; setRefreshPct(0); loadDepartures(station.code); }, REFRESH_INTERVAL);
    return () => { clearInterval(timerRef.current); clearInterval(pctRef.current); };
  }, [screen, station, loadDepartures]);

  const goBack = () => {
    setScreen("search"); setDeps(null); setError(null); setToasts([]);
    clearInterval(timerRef.current); clearInterval(pctRef.current);
    prevDepsRef.current = null;
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const dismissToast = (id) => setToasts(t => t.filter(x => x.id !== id));

  useEffect(() => {
    if (!toasts.length) return;
    const timer = setTimeout(() => setToasts(t => t.slice(1)), 8000);
    return () => clearTimeout(timer);
  }, [toasts]);

  return (
    <>
      <style>{getCSS(dark)}</style>
      <div className="app">
        {toasts.length > 0 && (
          <div className="toast-wrap" role="alert" aria-live="assertive">
            {toasts.map(t => (
              <div className="toast" key={t.id}>
                <span className="toast-icon">{t.tier === "now-confirmed" ? "\u2705" : "\u26A0\uFE0F"}</span>
                {t.tier === "now-confirmed"
                  ? <span>Platform {t.plat} now <strong>confirmed</strong> for {t.dest}</span>
                  : <span>Platform changed to <strong>{t.plat}</strong> for {t.dest}</span>
                }
                <button className="toast-close" onClick={() => dismissToast(t.id)}>{"\u2715"}</button>
              </div>
            ))}
          </div>
        )}

        {screen === "search" && (
          <div className="search-screen">
            <button className="theme-toggle" onClick={() => setDark(d => !d)} aria-label="Toggle theme">
              {dark ? <SunIcon/> : <MoonIcon/>}
            </button>
            <div className="logo">Platform</div>
            <div className="tagline">Live platforms and seat guidance</div>
            <div className="search-wrap" role="combobox" aria-expanded={showDrop} aria-haspopup="listbox">
              <div className="search-icon"><SearchIcon/></div>
              <input ref={inputRef} className="search-input" placeholder="Where are you departing from?"
                value={query} onChange={e => setQuery(e.target.value)}
                onFocus={() => { if (filtered.length) setShowDrop(true); }}
                onBlur={() => setTimeout(() => setShowDrop(false), 200)}
                autoComplete="off" aria-label="Search stations" role="searchbox"/>
              {showDrop && filtered.length > 0 && (
                <div className="dropdown" role="listbox">
                  {filtered.map(s => (
                    <div key={s.code} className="dropdown-item" role="option" onMouseDown={() => selectStation(s)}>
                      <span className="dropdown-name">{s.name}</span>
                      <span className="dropdown-code">{s.code}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {recent.length > 0 && !query && (
              <div className="recent-section">
                <div className="recent-label">Recent stations</div>
                <div className="recent-list">
                  {recent.map(s => (
                    <div key={s.code} className="recent-btn" role="button" tabIndex={0}
                      onClick={() => selectStation(s)} onKeyDown={e => e.key === "Enter" && selectStation(s)}>
                      <span className="recent-name">{s.name}</span>
                      <span className="recent-code">{s.code}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="donate-section" onClick={() => window.open("https://donate.stripe.com/YOUR_LINK","_blank")} role="button" tabIndex={0}>
              <span>{"\u2764\uFE0F"}</span>
              <span className="donate-text">Enjoying Platform? <strong>Help keep it running</strong></span>
            </div>
          </div>
        )}

        {screen === "board" && (
          <div className="board-screen">
            <div className="board-header">
              <div className="header-row1">
                <button className="back-btn" onClick={goBack} aria-label="Back to search"><BackIcon/></button>
                <span className="station-name">{station?.name}</span>
                <span className="header-clock">{clock}</span>
              </div>
              <div className="header-row2">
                <span className="header-sub">{lastUpText ? `Updated ${lastUpText}` : "Loading\u2026"}</span>
                <div className="header-actions">
                  <button className="live-pill" onClick={() => station && loadDepartures(station.code)} aria-label="Refresh departures">
                    <span className="live-dot"/>LIVE
                  </button>
                  <button className="theme-btn-sm" onClick={() => setDark(d => !d)} aria-label="Toggle theme">
                    {dark ? <SunIcon/> : <MoonIcon/>}
                  </button>
                </div>
              </div>
              <div className="refresh-bar"><div className="refresh-fill" style={{width:`${refreshPct}%`}}/></div>
            </div>

            {loading && !deps && (
              <div className="loading-wrap"><div className="spinner"/><span style={{color:"var(--text-muted)",fontSize:14}}>Loading departures{"\u2026"}</span></div>
            )}
            {error && (
              <div className="error-wrap"><div className="error-msg">Unable to load departures</div><button className="retry-btn" onClick={() => station && loadDepartures(station.code)}>Retry</button></div>
            )}
            {!loading && !error && deps && deps.length === 0 && (
              <div className="empty-wrap"><div className="empty-icon">{"\uD83D\uDE89"}</div><div className="empty-text">No departures in the next hour</div></div>
            )}
            {deps && deps.length > 0 && (
              <>
                <CompactLegend/>
                <div className="card-list" role="list" aria-label="Departures">
                  {deps.map((svc, i) => <DepartureCard key={i} svc={svc}/>)}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
