import { useState, useEffect, useRef, useCallback } from "react";

const API_BASE = "/api";
const REFRESH_INTERVAL = 30000;

// ── Unreserved Coach Guidance (curated by operator) ──
const COACH_GUIDANCE = {
  "LNER": { coaches: "C & U", tip: "Coaches C and U are unreserved. Head to the middle of the train for Coach C." },
  "Avanti West Coast": { coaches: "A & L", tip: "Coaches A and L are typically unreserved. Coach A is at the rear of the train." },
  "CrossCountry": { coaches: "A", tip: "Coach A is usually unreserved and located at the rear of the train." },
  "Great Western Railway": { coaches: "C & L", tip: "Coaches C and L are often unreserved on GWR intercity services." },
  "TransPennine Express": { coaches: "A & B", tip: "Coaches A and B are typically unreserved on TransPennine services." },
  "East Midlands Railway": { coaches: "A & B", tip: "Coaches A and B are usually unreserved on EMR intercity services." },
};

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
  // Filter to departures only — exclude terminating services
  if (data.services) {
    data.services = data.services.filter(svc => {
      const dep = svc.temporalData?.departure;
      if (!dep) return false;
      if (!dep.scheduleAdvertised) return false;
      return true;
    });
  }
  return data;
}

// ── Helpers ──
function fmtTime(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function minsUntil(iso) {
  if (!iso) return null;
  const diff = Math.round((new Date(iso) - new Date()) / 60000);
  if (diff < 0) return null;
  return diff;
}

function minsLabel(mins) {
  if (mins === null) return "";
  if (mins <= 0) return "Due";
  if (mins === 1) return "1 min";
  return `${mins} min`;
}

function getStatus(svc) {
  const dep = svc.temporalData?.departure;
  if (!dep) return { key: "on-time", label: "On time" };
  if (dep.isCancelled) return { key: "cancelled", label: "Cancelled" };
  const lat = dep.realtimeAdvertisedLateness;
  if (lat && lat > 0) return { key: "delayed", label: `+${lat} min` };
  return { key: "on-time", label: "On time" };
}

function getPlatform(svc) {
  const dep = svc.temporalData?.departure;
  const plat = svc.locationMetadata?.platform;
  if (dep?.isCancelled) return { text: "N/A", tier: "cancelled", label: "", announced: false };
  if (!plat) return { text: "\u2014", tier: "unknown", label: "Not yet known", announced: false };
  if (plat.actual) {
    const changed = plat.planned && plat.actual !== plat.planned;
    if (changed) return { text: plat.actual, tier: "changed", label: "Platform changed", announced: true };
    return { text: plat.actual, tier: "confirmed", label: "Confirmed", announced: true };
  }
  if (plat.planned) return { text: plat.planned, tier: "expected", label: "Expected \u2014 not yet announced", announced: false };
  return { text: "\u2014", tier: "unknown", label: "Not yet known", announced: false };
}

function getEffectiveTime(svc) {
  const dep = svc.temporalData?.departure;
  return dep?.realtimeForecast || dep?.realtimeActual || dep?.scheduleAdvertised;
}

function getScheduledTime(svc) {
  return svc.temporalData?.departure?.scheduleAdvertised;
}

function getDestination(svc) {
  return svc.destination?.[0]?.location?.description || "Unknown";
}

function getOperator(svc) {
  return svc.scheduleMetadata?.operator?.name || "";
}

function nowHHMM() {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// ── Styles ──
function getCSS(dark) {
  const t = dark ? {
    bg: "#090913", bgCard: "#101020", bgCardHover: "#141428", bgInput: "#16162a",
    text: "#f1f5f9", textMuted: "#94a3b8", textDim: "#475569",
    border: "#1e1e35", borderLight: "#252542", headerBg: "rgba(9,9,19,.92)",
  } : {
    bg: "#f5f5f7", bgCard: "#ffffff", bgCardHover: "#f0f0f5", bgInput: "#eeeef2",
    text: "#1a1a2e", textMuted: "#555570", textDim: "#8888a0",
    border: "#dddde5", borderLight: "#e5e5ed", headerBg: "rgba(245,245,247,.92)",
  };

  return `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:${t.bg};--bg-card:${t.bgCard};--bg-card-hover:${t.bgCardHover};--bg-input:${t.bgInput};
    --accent:#6366f1;--accent-dim:rgba(99,102,241,0.12);
    --amber:#f59e0b;--green:#10b981;--red:#ef4444;--orange:#f97316;
    --text:${t.text};--text-muted:${t.textMuted};--text-dim:${t.textDim};
    --border:${t.border};--border-light:${t.borderLight};--header-bg:${t.headerBg};
  }
  body,#root{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;transition:background .3s,color .3s}
  .app{max-width:480px;margin:0 auto;min-height:100vh;position:relative}

  .search-screen{display:flex;flex-direction:column;align-items:center;padding:0 20px;padding-top:12vh;min-height:100vh}
  .logo{font-size:44px;font-weight:900;letter-spacing:-2px;background:linear-gradient(135deg,#6366f1 0%,#818cf8 50%,#a5b4fc 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:2px}
  .tagline{color:var(--text-dim);font-size:14px;font-weight:500;margin-bottom:28px;letter-spacing:.5px}
  .search-wrap{width:100%;position:relative}
  .search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--text-dim);pointer-events:none}
  .search-input{width:100%;padding:16px 16px 16px 48px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:14px;color:var(--text);font-size:16px;font-family:inherit;outline:none;transition:all .2s}
  .search-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.15)}
  .search-input::placeholder{color:var(--text-dim)}
  .search-hint{color:var(--text-dim);font-size:12px;margin-top:10px;text-align:center}
  .theme-toggle{position:absolute;top:20px;right:20px;background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
  .theme-toggle:hover{border-color:var(--accent)}

  .dropdown{position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;z-index:50;max-height:320px;overflow-y:auto;box-shadow:0 20px 50px rgba(0,0,0,.3)}
  .dropdown-item{padding:13px 16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:background .15s;border-bottom:1px solid var(--border)}
  .dropdown-item:last-child{border-bottom:none}
  .dropdown-item:hover{background:var(--accent-dim)}
  .dropdown-name{font-size:14px;font-weight:500}
  .dropdown-code{font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:3px 8px;border-radius:6px;letter-spacing:.5px}

  .board-screen{display:flex;flex-direction:column;min-height:100vh}
  .board-header{position:sticky;top:0;z-index:40;background:var(--header-bg);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);padding:12px 16px 0;border-bottom:1px solid var(--border)}
  .header-row1{display:flex;align-items:center;gap:8px}
  .back-btn{background:none;border:none;color:var(--text-muted);cursor:pointer;padding:6px;border-radius:8px;display:flex;align-items:center;transition:all .2s}
  .back-btn:hover{color:var(--text);background:var(--accent-dim)}
  .station-name{font-size:17px;font-weight:800;letter-spacing:-.5px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .header-clock{font-size:17px;font-weight:800;color:var(--accent);letter-spacing:-.5px;font-variant-numeric:tabular-nums}
  .header-row2{display:flex;align-items:center;justify-content:space-between;padding-left:36px;margin-top:3px}
  .header-sub{font-size:11px;color:var(--text-dim)}
  .header-actions{display:flex;align-items:center;gap:6px}
  .live-pill{display:flex;align-items:center;gap:5px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);padding:3px 10px;border-radius:14px;cursor:pointer;font-size:10px;font-weight:700;color:var(--green);letter-spacing:.8px;text-transform:uppercase;transition:background .2s}
  .live-pill:hover{background:rgba(16,185,129,.15)}
  .live-dot{width:6px;height:6px;background:var(--green);border-radius:50%;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .theme-btn-sm{background:var(--bg-input);border:1px solid var(--border);border-radius:8px;padding:4px 6px;cursor:pointer;display:flex;align-items:center;color:var(--text-muted)}
  .refresh-bar{height:2px;background:var(--border);overflow:hidden}
  .refresh-fill{height:100%;background:var(--accent);transition:width 1s linear}

  .card-list{padding:6px 10px 80px;display:flex;flex-direction:column;gap:6px}

  .dep-card{background:var(--bg-card);border-radius:12px;border-left:3.5px solid;display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;padding:12px 12px 12px 14px;align-items:center;cursor:pointer;transition:background .15s}
  .dep-card:hover{background:var(--bg-card-hover)}
  .dep-card.on-time{border-left-color:var(--green)}
  .dep-card.delayed{border-left-color:var(--amber)}
  .dep-card.cancelled{border-left-color:var(--red);opacity:.55}

  .countdown-col{display:flex;flex-direction:column;align-items:center;min-width:52px}
  .countdown-num{font-size:24px;font-weight:900;letter-spacing:-1px;line-height:1;font-variant-numeric:tabular-nums}
  .countdown-due{font-size:18px;font-weight:900;letter-spacing:-.5px;color:var(--green)}
  .countdown-unit{font-size:10px;font-weight:600;color:var(--text-dim);margin-top:1px}
  .countdown-time{font-size:10px;font-weight:600;color:var(--text-dim);font-variant-numeric:tabular-nums;margin-top:2px}

  .info-col{display:flex;flex-direction:column;gap:2px;min-width:0}
  .dest-name{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
  .meta-row{display:flex;align-items:center;gap:6px;margin-top:1px;flex-wrap:wrap}
  .status-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;letter-spacing:.2px;text-transform:uppercase}
  .status-on-time{background:rgba(16,185,129,.1);color:var(--green)}
  .status-delayed{background:rgba(245,158,11,.1);color:var(--amber)}
  .status-cancelled{background:rgba(239,68,68,.1);color:var(--red)}
  .operator-name{font-size:10px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:130px}

  .plat-col{display:flex;flex-direction:column;align-items:center;gap:2px;justify-self:end}
  .plat-badge{min-width:52px;height:52px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:22px;letter-spacing:-.5px;padding:0 6px;font-variant-numeric:tabular-nums}
  .plat-confirmed{background:linear-gradient(140deg,#f59e0b,#d97706);color:#090913;box-shadow:0 0 18px rgba(245,158,11,.3)}
  .plat-changed{background:linear-gradient(140deg,#f97316,#ea580c);color:#fff;box-shadow:0 0 18px rgba(249,115,22,.35);animation:platPulse 2s ease-in-out infinite}
  @keyframes platPulse{0%,100%{box-shadow:0 0 18px rgba(249,115,22,.35)}50%{box-shadow:0 0 24px rgba(249,115,22,.55)}}
  .plat-expected{background:transparent;color:var(--amber);border:2px solid rgba(245,158,11,.35);font-size:20px}
  .plat-unknown{background:var(--bg-input);color:var(--text-dim);border:2px dashed var(--border-light);font-size:18px}
  .plat-cancelled{background:rgba(239,68,68,.08);color:rgba(239,68,68,.5);border:1.5px solid rgba(239,68,68,.15);font-size:12px;font-weight:700}
  .plat-status{font-size:8px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;text-align:center;max-width:60px;line-height:1.2}
  .plat-status-confirmed{color:var(--amber)}
  .plat-status-changed{color:var(--orange)}
  .plat-status-expected{color:var(--text-dim)}
  .plat-status-unknown{color:var(--text-dim)}
  .plat-status-cancelled{color:var(--red)}

  .early-badge{font-size:8px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:1px 5px;border-radius:3px;letter-spacing:.3px;text-transform:uppercase;margin-top:1px}

  .expanded-area{grid-column:1/-1;padding-top:10px;margin-top:6px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px}

  .coach-tip{background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.15);border-radius:8px;padding:10px 12px;display:flex;gap:8px;align-items:flex-start}
  .coach-icon{font-size:16px;flex-shrink:0;margin-top:1px}
  .coach-content{display:flex;flex-direction:column;gap:2px}
  .coach-title{font-size:11px;font-weight:700;color:var(--accent)}
  .coach-desc{font-size:11px;color:var(--text-muted);line-height:1.4}

  .platform-tip{background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.15);border-radius:8px;padding:10px 12px;display:flex;gap:8px;align-items:flex-start}
  .platform-tip-icon{font-size:16px;flex-shrink:0;margin-top:1px}
  .platform-tip-text{font-size:11px;color:var(--text-muted);line-height:1.4}
  .platform-tip-text strong{color:var(--text);font-weight:600}

  .detail-row{display:flex;gap:16px;flex-wrap:wrap}
  .detail-item{display:flex;flex-direction:column;gap:1px}
  .detail-label{font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
  .detail-value{font-size:12px;font-weight:600;color:var(--text-muted)}

  .cancel-reason{font-size:11px;color:var(--red);font-weight:500;font-style:italic}

  .legend-toggle{display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;font-size:10px;color:var(--text-dim);cursor:pointer;font-weight:600}
  .legend-toggle:hover{color:var(--text-muted)}
  .legend{margin:0 10px 6px;padding:12px 14px;background:var(--bg-card);border-radius:10px;border:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
  .legend-title{font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px}
  .legend-row{display:flex;align-items:center;gap:10px}
  .legend-badge{width:32px;height:32px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0}
  .legend-desc{font-size:11px;color:var(--text-muted);line-height:1.3}
  .legend-desc strong{color:var(--text);font-weight:600}

  .loading-wrap,.error-wrap,.empty-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;text-align:center}
  .spinner{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;margin-bottom:14px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .error-msg{color:var(--red);font-weight:600;margin-bottom:16px;font-size:14px}
  .retry-btn{background:var(--accent);color:white;border:none;padding:10px 24px;border-radius:10px;font-weight:600;font-size:14px;font-family:inherit;cursor:pointer}
  .empty-icon{font-size:32px;margin-bottom:10px;opacity:.4}
  .empty-text{color:var(--text-muted);font-size:13px}

  .donate-float{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--bg-card);border:1px solid var(--border);border-radius:20px;padding:6px 14px;display:flex;align-items:center;gap:6px;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.2);transition:all .2s;z-index:50;max-width:480px}
  .donate-float:hover{border-color:var(--accent);box-shadow:0 4px 24px rgba(99,102,241,.15)}
  .donate-heart{font-size:14px}
  .donate-text{font-size:11px;color:var(--text-muted);font-weight:500}
  .donate-text strong{color:var(--text);font-weight:600}
  `;
}

// ── Icons ──
const SearchIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const BackIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>;
const InfoIcon = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
const SunIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
const MoonIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>;
const AlertIcon = () => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;

// ── Components ──
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
  const reasons = svc.reasons;
  const cancelReason = reasons?.find(r => r.type === "CANCEL")?.shortText
    || reasons?.find(r => r.type === "DELAY")?.shortText;
  const guidance = COACH_GUIDANCE[operator];

  return (
    <div className={`dep-card ${status.key}`} onClick={() => setExpanded(e => !e)}>
      <div className="countdown-col">
        {mins !== null && mins > 0 ? (
          <>
            <span className="countdown-num">{mins}</span>
            <span className="countdown-unit">min</span>
          </>
        ) : mins === 0 ? (
          <span className="countdown-due">Due</span>
        ) : (
          <span className="countdown-num" style={{fontSize:16}}>--</span>
        )}
        <span className="countdown-time">
          {isDelayed ? fmtTime(effective) : fmtTime(scheduled)}
        </span>
        {isDelayed && <span className="countdown-time" style={{textDecoration:"line-through",fontSize:9}}>{fmtTime(scheduled)}</span>}
      </div>

      <div className="info-col">
        <span className="dest-name">{dest}</span>
        <div className="meta-row">
          <span className={`status-badge status-${status.key}`}>{status.label}</span>
          <span className="operator-name">{operator}</span>
          {vehicles && <span className="operator-name">{vehicles} coaches</span>}
        </div>
        {!plat.announced && plat.tier === "expected" && (
          <span className="early-badge">Platform not yet announced</span>
        )}
      </div>

      <div className="plat-col">
        <div className={`plat-badge plat-${plat.tier}`}>{plat.text}</div>
        <span className={`plat-status plat-status-${plat.tier}`}>
          {plat.tier === "confirmed" ? "Confirmed" :
           plat.tier === "changed" ? (<><AlertIcon/> Changed</>) :
           plat.tier === "expected" ? "Expected" :
           plat.tier === "cancelled" ? "N/A" : ""}
        </span>
      </div>

      {expanded && (
        <div className="expanded-area">
          {/* Platform confidence tip */}
          {plat.tier === "expected" && (
            <div className="platform-tip">
              <span className="platform-tip-icon">{"\uD83D\uDFE1"}</span>
              <span className="platform-tip-text">
                <strong>Platform {plat.text} is expected</strong> based on the timetable but hasn't been confirmed yet. This is often correct, but check station boards for last-minute changes.
              </span>
            </div>
          )}
          {plat.tier === "confirmed" && (
            <div className="platform-tip">
              <span className="platform-tip-icon">{"\u2705"}</span>
              <span className="platform-tip-text">
                <strong>Platform {plat.text} is confirmed</strong> by live signalling data. Head there now.
              </span>
            </div>
          )}
          {plat.tier === "changed" && (
            <div className="platform-tip">
              <span className="platform-tip-icon">{"\u26A0\uFE0F"}</span>
              <span className="platform-tip-text">
                <strong>Platform has changed to {plat.text}.</strong> This differs from the timetabled platform. Make sure you're heading to the right one.
              </span>
            </div>
          )}

          {/* Coach guidance */}
          {guidance && status.key !== "cancelled" && (
            <div className="coach-tip">
              <span className="coach-icon">{"\uD83D\uDCBA"}</span>
              <div className="coach-content">
                <span className="coach-title">Unreserved: Coach{guidance.coaches.includes("&") ? "es" : ""} {guidance.coaches}</span>
                <span className="coach-desc">{guidance.tip}</span>
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
          </div>
        </div>
      )}
    </div>
  );
}

function PlatformLegend() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="legend-toggle" onClick={() => setOpen(o => !o)}>
        <InfoIcon/> {open ? "Hide guide" : "What do the platform badges mean?"} {open ? "\u25B4" : "\u25BE"}
      </div>
      {open && (
        <div className="legend">
          <div className="legend-title">Platform Confidence</div>
          <div className="legend-row">
            <div className="legend-badge plat-confirmed" style={{fontSize:13}}>4</div>
            <div className="legend-desc"><strong>Confirmed</strong> \u2014 Live signalling data. Go to this platform.</div>
          </div>
          <div className="legend-row">
            <div className="legend-badge plat-changed" style={{fontSize:13,color:"#fff"}}>7</div>
            <div className="legend-desc"><strong>Changed</strong> \u2014 Different from timetable. Double-check boards.</div>
          </div>
          <div className="legend-row">
            <div className="legend-badge plat-expected" style={{fontSize:12}}>4</div>
            <div className="legend-desc"><strong>Expected</strong> \u2014 Based on timetable. Not yet announced at station.</div>
          </div>
          <div className="legend-row">
            <div className="legend-badge plat-unknown" style={{fontSize:12}}>{"\u2014"}</div>
            <div className="legend-desc"><strong>Unknown</strong> \u2014 No platform information available yet.</div>
          </div>
        </div>
      )}
    </>
  );
}

// ── App ──
export default function App() {
  const [dark, setDark] = useState(() => {
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches; }
    catch { return true; }
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
  const [lastUp, setLastUp] = useState(null);
  const [clock, setClock] = useState(nowHHMM());
  const [refreshPct, setRefreshPct] = useState(0);
  const timerRef = useRef(null);
  const clockRef = useRef(null);
  const pctRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    fetchStations().then(setStations).catch(err => console.error("Stations:", err));
  }, []);

  useEffect(() => {
    clockRef.current = setInterval(() => setClock(nowHHMM()), 1000);
    return () => clearInterval(clockRef.current);
  }, []);

  useEffect(() => {
    if (!query.trim()) { setFiltered([]); setShowDrop(false); return; }
    const q = query.toLowerCase();
    const m = stations.filter(s =>
      s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)
    ).slice(0, 8);
    setFiltered(m);
    setShowDrop(m.length > 0);
  }, [query, stations]);

  const loadDepartures = useCallback(async (code) => {
    setLoading(true); setError(null);
    try {
      const data = await fetchDepartures(code);
      setDeps(data.services || []);
      setLastUp(nowHHMM());
      setRefreshPct(0);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const selectStation = useCallback((s) => {
    setStation(s); setQuery(""); setShowDrop(false);
    setScreen("board"); loadDepartures(s.code);
  }, [loadDepartures]);

  useEffect(() => {
    if (screen !== "board" || !station) return;
    let elapsed = 0;
    pctRef.current = setInterval(() => {
      elapsed += 1000;
      setRefreshPct(Math.min((elapsed / REFRESH_INTERVAL) * 100, 100));
    }, 1000);
    timerRef.current = setInterval(() => {
      elapsed = 0; setRefreshPct(0);
      loadDepartures(station.code);
    }, REFRESH_INTERVAL);
    return () => { clearInterval(timerRef.current); clearInterval(pctRef.current); };
  }, [screen, station, loadDepartures]);

  const goBack = () => {
    setScreen("search"); setDeps(null); setError(null);
    clearInterval(timerRef.current); clearInterval(pctRef.current);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  return (
    <>
      <style>{getCSS(dark)}</style>
      <div className="app">
        {screen === "search" && (
          <div className="search-screen">
            <button className="theme-toggle" onClick={() => setDark(d => !d)}>
              {dark ? <SunIcon/> : <MoonIcon/>}
            </button>
            <div className="logo">Platform</div>
            <div className="tagline">Know your platform before it's announced</div>
            <div className="search-wrap">
              <div className="search-icon"><SearchIcon/></div>
              <input ref={inputRef} className="search-input" placeholder="Where are you departing from?"
                value={query} onChange={e => setQuery(e.target.value)}
                onFocus={() => { if (filtered.length) setShowDrop(true); }}
                onBlur={() => setTimeout(() => setShowDrop(false), 200)}
                autoComplete="off"/>
              {showDrop && (
                <div className="dropdown">
                  {filtered.map(s => (
                    <div key={s.code} className="dropdown-item" onMouseDown={() => selectStation(s)}>
                      <span className="dropdown-name">{s.name}</span>
                      <span className="dropdown-code">{s.code}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="search-hint">Search by station name or code</div>
          </div>
        )}

        {screen === "board" && (
          <div className="board-screen">
            <div className="board-header">
              <div className="header-row1">
                <button className="back-btn" onClick={goBack}><BackIcon/></button>
                <span className="station-name">{station?.name}</span>
                <span className="header-clock">{clock}</span>
              </div>
              <div className="header-row2">
                <span className="header-sub">{lastUp ? `Updated ${lastUp}` : "Loading\u2026"}</span>
                <div className="header-actions">
                  <button className="live-pill" onClick={() => station && loadDepartures(station.code)}>
                    <span className="live-dot"/>LIVE
                  </button>
                  <button className="theme-btn-sm" onClick={() => setDark(d => !d)}>
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
              <div className="empty-wrap"><div className="empty-icon">{"\uD83D\uDE89"}</div><div className="empty-text">No departures found</div></div>
            )}
            {deps && deps.length > 0 && (
              <>
                <PlatformLegend/>
                <div className="card-list">
                  {deps.map((svc, i) => <DepartureCard key={i} svc={svc}/>)}
                </div>
              </>
            )}
          </div>
        )}

        <div className="donate-float" onClick={() => window.open("https://donate.stripe.com/YOUR_LINK", "_blank")}>
          <span className="donate-heart">{"\u2764\uFE0F"}</span>
          <span className="donate-text">Enjoying Platform? <strong>Help keep it running</strong></span>
        </div>
      </div>
    </>
  );
}
