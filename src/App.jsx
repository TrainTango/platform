import { useState, useEffect, useRef, useCallback } from "react";

const API_BASE = "/api";
const REFRESH_INTERVAL = 30000;

// ── Analytics ──
function getVisitorId() {
  try {
    let id = localStorage.getItem("platform_visitor");
    if (!id) { id = crypto.randomUUID(); localStorage.setItem("platform_visitor", id); }
    return id;
  } catch { return "unknown"; }
}

function trackEvent(type, data) {
  try {
    fetch(`${API_BASE}/analytics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, visitor_id: getVisitorId(), ...data }),
    }).catch(() => {});
  } catch {}
}

// ── Seating Guidance ──
const COACH_GUIDANCE = {
  "LNER": { confidence: "high", coaches: "C", short: "Head to Coach C for unreserved seats.", cardLabel: "\uD83D\uDCBA Unreserved: C" },
  "Hull Trains": { confidence: "high", coaches: "A", short: "Head to Coach A for unreserved seats.", cardLabel: "\uD83D\uDCBA Unreserved: A" },
  "Avanti West Coast": { confidence: "hint", coaches: "C", short: "Coach C may have unreserved seats.", cardLabel: "\uD83D\uDCA1 Coach C may be free", verified: "Mar 2026" },
  "Great Western Railway": { confidence: "hint", coaches: "G", short: "Coach G may have unreserved seats on London services.", cardLabel: "\uD83D\uDCA1 Coach G may be free", verified: "Mar 2026" },
  "East Midlands Railway": { confidence: "hint", coaches: "D", short: "Coach D may have unreserved seats on London services.", cardLabel: "\uD83D\uDCA1 Coach D may be free", verified: "Mar 2026" },
  "TransPennine Express": { confidence: "hint", coaches: "D", short: "Coach D may have unreserved seats on Nova trains.", cardLabel: "\uD83D\uDCA1 Coach D may be free", verified: "Mar 2026" },
  "Grand Central": { confidence: "hint", coaches: "B", short: "Part of Coach B may be unreserved.", cardLabel: "\uD83D\uDCA1 Coach B may be free", verified: "Mar 2026" },
  "Lumo": { confidence: "hint", coaches: null, short: "Very limited unreserved seats — look for green lights above seats.", cardLabel: "\uD83D\uDCA1 Limited unreserved", verified: "Mar 2026" },
};

function getCrossCountryGuidance(numVehicles) {
  if (numVehicles >= 9) return { confidence: "hint", coaches: "B, H & L", short: "Head to Coaches B, H or L for unreserved seats.", cardLabel: "\uD83D\uDCA1 Coaches B, H, L may be free", verified: "Apr 2026" };
  if (numVehicles >= 5) return { confidence: "hint", coaches: "B", short: "Coach B may have unreserved seats.", cardLabel: "\uD83D\uDCA1 Coach B may be free", verified: "Apr 2026" };
  return { confidence: "hint", coaches: "D", short: "Some seats in Coach D may be unreserved.", cardLabel: "\uD83D\uDCA1 Coach D may be free", verified: "Apr 2026" };
}

const NO_RESERVATION_OPERATORS = new Set([
  "c2c", "Chiltern Railways", "Elizabeth line", "Gatwick Express",
  "Great Northern", "Greater Anglia", "Heathrow Express",
  "London Northwestern Railway", "London Overground", "Merseyrail",
  "Northern", "South Western Railway", "Southeastern", "Southern",
  "Stansted Express", "Thameslink", "Transport for Wales",
  "West Midlands Railway",
]);

const COMPULSORY_RESERVATION = new Set(["Caledonian Sleeper"]);

function isPeakHour() {
  const h = new Date().getHours(), m = new Date().getMinutes();
  const t = h * 60 + m;
  return (t >= 420 && t <= 570) || (t >= 990 && t <= 1140);
}

function getGuidance(operator, numVehicles) {
  if (operator === "CrossCountry") return getCrossCountryGuidance(numVehicles);
  return COACH_GUIDANCE[operator] || null;
}

// ── Recent Routes ──
function getRecent() {
  try { const r = JSON.parse(localStorage.getItem("platform_recent_v2")); return Array.isArray(r) ? r.slice(0, 3) : []; }
  catch { return []; }
}
function saveRecent(from, to) {
  try {
    let r = getRecent().filter(rt => !(rt.from.code === from.code && (rt.to?.code || "") === (to?.code || "")));
    r.unshift({ from, to: to || null });
    localStorage.setItem("platform_recent_v2", JSON.stringify(r.slice(0, 3)));
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

async function fetchDepartures(code, toCode) {
  let url = `${API_BASE}/departures?code=${code}`;
  if (toCode) url += `&to=${toCode}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Failed to fetch departures");
  const data = await r.json();
  const all = data.services || [];
  const departures = all.filter(svc => svc.temporalData?.departure);
  return { departures, allServices: all };
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
  if (plat.actual) {
    const changed = plat.planned && plat.actual !== plat.planned;
    if (changed) return { text: plat.actual, tier: "changed", label: "Changed" };
    return { text: plat.actual, tier: "confirmed", label: "Confirmed" };
  }
  if (plat.forecast) return { text: plat.forecast, tier: "expected", label: "Expected" };
  if (plat.planned) return { text: plat.planned, tier: "expected", label: "Expected" };
  return { text: "\u2014", tier: "unknown", label: "Unknown" };
}

function getEffectiveTime(svc) {
  const dep = svc.temporalData?.departure;
  return dep?.realtimeForecast || dep?.realtimeActual || dep?.scheduleAdvertised;
}
function getScheduledTime(svc) { return svc.temporalData?.departure?.scheduleAdvertised; }
function getDestination(svc) {
  const dests = svc.destination?.map(d => d.location?.description).filter(Boolean);
  if (!dests || !dests.length) return "Unknown";
  return dests.join(" / ");
}
function getOperator(svc) { return svc.scheduleMetadata?.operator?.name || ""; }
function nowHHMM() { return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }); }
function svcKey(svc) {
  const uid = svc.scheduleMetadata?.uniqueIdentity || svc.scheduleMetadata?.identity;
  return uid || `${getDestination(svc)}-${getScheduledTime(svc)}`;
}

// ── Platform Messaging System ──
const OCCUPYING_STATUSES = new Set(["AT_PLATFORM", "DEPART_PREPARING", "DEPART_READY", "ARRIVING"]);

function isSameService(a, b) {
  const uidA = a.scheduleMetadata?.uniqueIdentity || a.scheduleMetadata?.identity;
  const uidB = b.scheduleMetadata?.uniqueIdentity || b.scheduleMetadata?.identity;
  return uidA && uidB && uidA === uidB;
}

function checkPlatformOccupancy(userService, allServices) {
  const userPlat = userService.locationMetadata?.platform;
  const platNum = userPlat?.actual || userPlat?.forecast || userPlat?.planned;
  if (!platNum || !allServices) return { occupied: false };
  for (const svc of allServices) {
    if (isSameService(svc, userService)) continue;
    const svcPlat = svc.locationMetadata?.platform;
    const svcPlatNum = svcPlat?.actual || svcPlat?.forecast || svcPlat?.planned;
    if (svcPlatNum !== platNum) continue;
    const status = svc.temporalData?.departure?.status || svc.temporalData?.arrival?.status;
    if (status && OCCUPYING_STATUSES.has(status)) return { occupied: true };
  }
  return { occupied: false };
}

function getPlatformMessage(userService, allServices) {
  const dep = userService.temporalData?.departure;
  const plat = userService.locationMetadata?.platform;

  if (dep?.isCancelled) return { title: "This service is cancelled", description: "Check the next service to your destination.", icon: "\u274C", cardLabel: "Cancelled", tier: "cancelled", tipClass: "tip-hint" };

  if (!plat || (!plat.actual && !plat.forecast && !plat.planned)) return { title: "No platform yet", description: "We'll show it here as soon as it's available.", icon: "\u23F3", cardLabel: "Unknown", tier: "unknown", tipClass: "tip-hint" };

  const platNum = plat.actual || plat.forecast || plat.planned;
  const platTier = plat.actual ? (plat.planned && plat.actual !== plat.planned ? "changed" : "confirmed") : "expected";
  const isChanged = platTier === "changed";

  if (platTier === "expected") return { title: `Platform ${platNum} expected`, description: "We'll update this once the platform is confirmed.", icon: "\uD83D\uDFE1", cardLabel: "Expected", tier: "expected", tipClass: "tip-platform" };

  const departureStatus = dep?.status || null;
  const hasActualDep = !!dep?.realtimeActual;
  if (departureStatus === "DEPARTING" || hasActualDep) return { title: "This train has departed", description: "Check the next service to your destination.", icon: "\uD83D\uDE86", cardLabel: "Departed", tier: "departed", tipClass: "tip-hint" };

  const confirmed = departureStatus === "ARRIVING" || departureStatus === "AT_PLATFORM" || departureStatus === "DEPART_PREPARING" || departureStatus === "DEPART_READY";

  if (confirmed) {
    return {
      title: isChanged ? `Platform changed to ${platNum} — board now` : `Your train is at Platform ${platNum}`,
      description: isChanged ? "Confirmed via live data. This is your train — board now." : "This is your train — board now.",
      icon: isChanged ? "\u26A0\uFE0F" : "\u2705",
      cardLabel: isChanged ? "Changed" : "Board now",
      tier: "board", tipClass: isChanged ? "tip-platform-changed" : "tip-platform"
    };
  }

  const effective = dep?.realtimeForecast || dep?.scheduleAdvertised;
  const minsOut = effective ? Math.round((new Date(effective) - new Date()) / 60000) : null;
  const likelyHere = minsOut !== null && minsOut <= 3;

  if (likelyHere) {
    return {
      title: isChanged ? `Platform changed to ${platNum} — check train` : `Platform ${platNum} — check train`,
      description: "Your train is likely here. Check the destination on the train before boarding.",
      icon: isChanged ? "\u26A0\uFE0F" : "\uD83D\uDFE1",
      cardLabel: "Check train", tier: "go-caution", tipClass: isChanged ? "tip-platform-changed" : "tip-platform"
    };
  }

  const { occupied } = checkPlatformOccupancy(userService, allServices);
  if (occupied) {
    return {
      title: isChanged ? `Platform changed to ${platNum} — check train` : `Platform ${platNum} — another train there now`,
      description: "A different service is at this platform. Check the destination on the train before boarding.",
      icon: "\uD83D\uDFE1", cardLabel: "Check train", tier: "go-caution", tipClass: isChanged ? "tip-platform-changed" : "tip-platform"
    };
  }

  return {
    title: isChanged ? `Platform changed to ${platNum} — head there now` : `Platform ${platNum} confirmed — head there now`,
    description: "Get there early and be first to board.",
    icon: isChanged ? "\u26A0\uFE0F" : "\u2705",
    cardLabel: isChanged ? "Changed" : "Confirmed",
    tier: "go", tipClass: isChanged ? "tip-platform-changed" : "tip-platform"
  };
}

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

  .search-fields{width:100%;display:flex;flex-direction:column;gap:8px}
  .field-wrap{position:relative;width:100%}
  .field-label{font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
  .search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--text-dim);pointer-events:none}
  .search-input{width:100%;padding:14px 14px 14px 44px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:12px;color:var(--text);font-size:15px;font-family:inherit;outline:none;transition:border-color .2s,box-shadow .2s}
  .search-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.15)}
  .search-input::placeholder{color:var(--text-dim)}
  .search-input-sm{padding:12px 14px 12px 40px;font-size:14px}
  .dest-optional{position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--text-dim);pointer-events:none}
  .clear-dest{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:var(--bg-input);border:1px solid var(--border);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--text-muted);cursor:pointer;font-family:inherit}

  .go-btn{width:100%;padding:14px;background:var(--accent);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;margin-top:4px;transition:opacity .2s}
  .go-btn:hover{opacity:.9}
  .go-btn:disabled{opacity:.4;cursor:default}

  .theme-toggle{position:absolute;top:20px;right:20px;background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;transition:border-color .2s}
  .theme-toggle:hover{border-color:var(--accent)}

  .recent-section{width:100%;margin-top:16px}
  .recent-label{font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
  .recent-list{display:flex;flex-direction:column;gap:6px}
  .recent-btn{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;cursor:pointer;transition:background .15s;min-height:48px}
  .recent-btn:hover{background:var(--bg-card-hover)}
  .recent-route{display:flex;flex-direction:column;gap:2px}
  .recent-from{font-size:14px;font-weight:600;color:var(--text)}
  .recent-to{font-size:12px;color:var(--text-muted)}
  .recent-codes{display:flex;gap:4px}
  .recent-code{font-size:10px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:2px 6px;border-radius:4px}

  .dropdown{position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;z-index:50;max-height:240px;overflow-y:auto;box-shadow:0 12px 40px var(--shadow)}
  .dropdown-item{padding:13px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:background .15s;border-bottom:1px solid var(--border);min-height:44px}
  .dropdown-item:last-child{border-bottom:none}
  .dropdown-item:hover{background:var(--accent-dim)}
  .dropdown-name{font-size:13px;font-weight:500}
  .dropdown-code{font-size:10px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:2px 6px;border-radius:5px}

  .board-screen{display:flex;flex-direction:column;min-height:100vh}
  .board-header{position:sticky;top:0;z-index:40;background:var(--header-bg);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);padding:12px 16px 0;border-bottom:1px solid var(--border)}
  .header-row1{display:flex;align-items:center;gap:8px}
  .back-btn{background:none;border:none;color:var(--text-muted);cursor:pointer;padding:12px;border-radius:10px;display:flex;align-items:center;min-width:44px;min-height:44px;justify-content:center;transition:all .2s}
  .back-btn:hover{color:var(--text);background:var(--accent-dim)}
  .header-title{flex:1;min-width:0}
  .station-name{font-size:17px;font-weight:800;letter-spacing:-.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
  .route-to{font-size:12px;color:var(--text-dim);font-weight:500}
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
  .countdown-due{font-size:14px;font-weight:700;color:var(--green)}
  .countdown-unit{font-size:11px;font-weight:600;color:var(--text-dim);margin-top:2px}

  .info-col{display:flex;flex-direction:column;gap:3px;min-width:0}
  .dest-name{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
  .meta-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  .status-badge{font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px;letter-spacing:.2px;text-transform:uppercase}
  .status-on-time{background:rgba(16,185,129,.1);color:var(--green)}
  .status-delayed{background:rgba(245,158,11,.1);color:var(--amber)}
  .status-cancelled{background:rgba(239,68,68,.1);color:var(--red)}
  .coach-pill{font-size:11px;font-weight:600;color:var(--accent);background:var(--accent-dim);padding:2px 7px;border-radius:5px}
  .coach-pill-hint{color:var(--text-muted);background:transparent;border:1.5px dashed var(--border-light);padding:1px 6px}
  .coach-pill-free{color:var(--green);background:rgba(16,185,129,.1)}
  .coach-pill-none{color:var(--text-dim);background:transparent;border:1px solid var(--border);padding:1px 6px}
  .operator-name{font-size:11px;color:var(--text-dim)}

  .plat-col{display:flex;flex-direction:column;align-items:center;gap:2px;justify-self:end}
  .plat-badge{min-width:54px;height:54px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:22px;letter-spacing:-.5px;padding:0 6px;font-variant-numeric:tabular-nums;position:relative}
  .plat-badge-icon{position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;border:2px solid var(--bg)}
  .plat-icon-confirmed{background:#2d6a4f;color:#e8f5ec}
  .plat-icon-changed{background:#e8623a;color:#fff}
  .plat-icon-expected{background:var(--border-light);color:var(--text-muted)}
  .plat-confirmed{background:#2d6a4f;color:#e8f5ec;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .plat-changed{background:#e8623a;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.1)}
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
  .tip-platform-changed{background:rgba(232,98,58,.08);border:1px solid rgba(232,98,58,.2)}
  .tip-coach{background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.12)}
  .tip-hint{background:var(--bg-input);border:1px solid var(--border)}
  .tip-free{background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.12)}
  .tip-icon{font-size:16px;flex-shrink:0;margin-top:1px}
  .tip-content{display:flex;flex-direction:column;gap:2px}
  .tip-title{font-size:12px;font-weight:700;color:var(--text)}
  .tip-desc{font-size:12px;color:var(--text-muted);line-height:1.4}
  .tip-hint .tip-title{color:var(--text-muted)}
  .tip-hint .tip-desc{color:var(--text-dim)}
  .tip-meta{display:flex;align-items:center;gap:10px;margin-top:4px}
  .tip-verified{font-size:11px;color:var(--text-dim)}
  .tip-report{font-size:11px;color:var(--accent);cursor:pointer;text-decoration:underline;background:none;border:none;font-family:inherit;padding:0}
  .tip-report:hover{opacity:.7}
  .tip-peak{font-size:11px;color:var(--amber);font-weight:600;margin-top:2px}

  .feedback-btn{display:flex;align-items:center;gap:6px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.15);border-radius:8px;padding:8px 12px;cursor:pointer;transition:background .15s;width:100%}
  .feedback-btn:hover{background:rgba(16,185,129,.15)}
  .feedback-btn-done{background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.3);cursor:default}
  .feedback-text{font-size:12px;font-weight:600;color:var(--green)}

  .detail-row{display:flex;gap:16px;flex-wrap:wrap}
  .detail-item{display:flex;flex-direction:column;gap:1px}
  .detail-label{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
  .detail-value{font-size:12px;font-weight:600;color:var(--text-muted)}
  .cancel-reason{font-size:12px;color:var(--red);font-weight:500;font-style:italic}

  .legend-bar{display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 10px;flex-wrap:wrap}
  .legend-item{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim);font-weight:500}
  .legend-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
  .legend-dot-confirmed{background:#2d6a4f}
  .legend-dot-changed{background:#e8623a}
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
const SearchIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const ArrowIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>;
const BackIcon = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>;
const SunIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
const MoonIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>;

// ── Components ──
function DepartureCard({ svc, allServices, stationCode }) {
  const [expanded, setExpanded] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const status = getStatus(svc);
  const plat = getPlatform(svc);
  const dest = getDestination(svc);
  const operator = getOperator(svc);
  const scheduled = getScheduledTime(svc);
  const effective = getEffectiveTime(svc);
  const mins = minsUntil(effective);
  const isDelayed = status.key === "delayed";
  const vehicles = svc.locationMetadata?.numberOfVehicles;
  const guidance = getGuidance(operator, vehicles);
  const isNoReservation = NO_RESERVATION_OPERATORS.has(operator);
  const isCompulsory = COMPULSORY_RESERVATION.has(operator);
  const reasons = svc.reasons;
  const cancelReason = reasons?.find(r => r.type === "CANCEL")?.shortText || reasons?.find(r => r.type === "DELAY")?.shortText;
  const platMsg = getPlatformMessage(svc, allServices);

  return (
    <div className={`dep-card ${status.key}`} role="button" tabIndex={0} aria-expanded={expanded}
      onClick={() => setExpanded(e => !e)} onKeyDown={e => e.key === "Enter" && setExpanded(x => !x)}>
      <div className="countdown-col">
        <span className="countdown-num">{fmtTime(scheduled)}</span>
        {mins !== null && mins > 0 ? (
          <span className="countdown-unit">{mins} min</span>
        ) : mins === 0 ? (
          <span className="countdown-due">Due</span>
        ) : null}
      </div>

      <div className="info-col">
        <span className="dest-name">{dest}</span>
        <div className="meta-row">
          <span className={`status-badge status-${status.key}`}>{status.label}</span>
          {status.key !== "cancelled" && guidance && (
            <span className={`coach-pill ${guidance.confidence === "hint" ? "coach-pill-hint" : ""}`}>{guidance.cardLabel}</span>
          )}
          {status.key !== "cancelled" && isNoReservation && (
            <span className="coach-pill coach-pill-free">{"\u2705"} No reservations</span>
          )}
          {status.key !== "cancelled" && !guidance && !isNoReservation && !isCompulsory && (
            <span className="coach-pill coach-pill-none">{"\u2139\uFE0F"} No seating info</span>
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
        <span className={`plat-status plat-status-${plat.tier}`}>{platMsg.cardLabel}</span>
      </div>

      {expanded && (
        <div className="expanded-area">
          {platMsg.tier !== "unknown" && (
            <div className={`tip-card ${platMsg.tipClass}`}>
              <span className="tip-icon">{platMsg.icon}</span>
              <div className="tip-content">
                <span className="tip-title">{platMsg.title}</span>
                {platMsg.description && <span className="tip-desc">{platMsg.description}</span>}
              </div>
            </div>
          )}

          {status.key !== "cancelled" && guidance && guidance.confidence === "high" && (
            <div className="tip-card tip-coach">
              <span className="tip-icon">{"\uD83D\uDCBA"}</span>
              <div className="tip-content">
                <span className="tip-title">{guidance.short}</span>
              </div>
            </div>
          )}
          {status.key !== "cancelled" && guidance && guidance.confidence === "hint" && (
            <div className="tip-card tip-hint">
              <span className="tip-icon">{"\uD83D\uDCA1"}</span>
              <div className="tip-content">
                <span className="tip-title">{guidance.short}</span>
                {isPeakHour() && <span className="tip-peak">{"\u23F0"} Peak time — unreserved seats fill quickly.</span>}
                <div className="tip-meta">
                  {guidance.verified && <span className="tip-verified">Verified {guidance.verified}</span>}
                  <button className="tip-report" onClick={e => { e.stopPropagation(); alert("Thanks! We'll review this."); }}>Report incorrect</button>
                </div>
              </div>
            </div>
          )}
          {status.key !== "cancelled" && isNoReservation && (
            <div className="tip-card tip-free">
              <span className="tip-icon">{"\u2705"}</span>
              <div className="tip-content">
                <span className="tip-title">No reservations — every seat is first come, first served.</span>
              </div>
            </div>
          )}
          {status.key !== "cancelled" && isCompulsory && (
            <div className="tip-card tip-hint">
              <span className="tip-icon">{"\u26A0\uFE0F"}</span>
              <div className="tip-content">
                <span className="tip-title">Reservation required — check your booking for coach and seat.</span>
              </div>
            </div>
          )}
          {status.key !== "cancelled" && !guidance && !isNoReservation && !isCompulsory && (
            <div className="tip-card tip-hint">
              <span className="tip-icon">{"\u2139\uFE0F"}</span>
              <div className="tip-content">
                <span className="tip-title">No seating info — look for unreserved seats when you get on the train.</span>
              </div>
            </div>
          )}

          <div className={`feedback-btn ${feedbackSent ? "feedback-btn-done" : ""}`} role="button" tabIndex={0}
            onClick={e => {
              e.stopPropagation();
              if (feedbackSent) return;
              setFeedbackSent(true);
              trackEvent("feedback", {
                station_code: stationCode || "",
                destination: dest, operator,
                platform: plat.text, platform_tier: plat.tier,
                seating_guidance: guidance?.cardLabel || (isNoReservation ? "No reservations" : ""),
              });
            }}>
            <span>{feedbackSent ? "\u2705" : "\uD83D\uDC4D"}</span>
            <span className="feedback-text">{feedbackSent ? "Thanks for the feedback!" : "This helped"}</span>
          </div>

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

// ── App ──
export default function App() {
  const [dark, setDark] = useState(() => {
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; }
  });
  const [screen, setScreen] = useState("search");
  const [stations, setStations] = useState([]);

  // Search fields
  const [fromQuery, setFromQuery] = useState("");
  const [fromStation, setFromStation] = useState(null);
  const [fromFiltered, setFromFiltered] = useState([]);
  const [showFromDrop, setShowFromDrop] = useState(false);

  const [toQuery, setToQuery] = useState("");
  const [toStation, setToStation] = useState(null);
  const [toFiltered, setToFiltered] = useState([]);
  const [showToDrop, setShowToDrop] = useState(false);

  const [deps, setDeps] = useState(null);
  const [allSvcs, setAllSvcs] = useState([]);
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
  const fromRef = useRef(null);

  useEffect(() => { fetchStations().then(setStations).catch(err => console.error("Stations:", err)); trackEvent("page_view"); }, []);

  useEffect(() => {
    clockRef.current = setInterval(() => {
      setClock(nowHHMM());
      if (lastUpDate) setLastUpText(relativeTime(lastUpDate));
    }, 1000);
    return () => clearInterval(clockRef.current);
  }, [lastUpDate]);

  // From station filter
  useEffect(() => {
    if (!fromQuery.trim()) { setFromFiltered([]); setShowFromDrop(false); return; }
    const q = fromQuery.toLowerCase();
    setFromFiltered(stations.filter(s => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)).slice(0, 6));
    setShowFromDrop(true);
  }, [fromQuery, stations]);

  // To station filter
  useEffect(() => {
    if (!toQuery.trim()) { setToFiltered([]); setShowToDrop(false); return; }
    const q = toQuery.toLowerCase();
    setToFiltered(stations.filter(s => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)).filter(s => s.code !== fromStation?.code).slice(0, 6));
    setShowToDrop(true);
  }, [toQuery, stations, fromStation]);

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

  const loadDepartures = useCallback(async (code, toCode) => {
    setLoading(true); setError(null);
    try {
      const data = await fetchDepartures(code, toCode);
      const svcs = data.departures;
      setAllSvcs(data.allServices);
      detectChanges(svcs);
      setDeps(svcs);
      const now = new Date();
      setLastUpDate(now);
      setLastUpText(relativeTime(now));
      setRefreshPct(0);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [detectChanges]);

  const go = useCallback(() => {
    if (!fromStation) return;
    saveRecent(fromStation, toStation);
    setRecent(getRecent());
    prevDepsRef.current = null;
    trackEvent("station_search", { station_code: fromStation.code, station_name: fromStation.name, destination_code: toStation?.code || "", destination_name: toStation?.name || "" });
    setScreen("board");
    loadDepartures(fromStation.code, toStation?.code);
  }, [fromStation, toStation, loadDepartures]);

  const selectFrom = (s) => {
    setFromStation(s); setFromQuery(s.name); setShowFromDrop(false);
  };

  const selectTo = (s) => {
    setToStation(s); setToQuery(s.name); setShowToDrop(false);
  };

  const selectRecent = (rt) => {
    setFromStation(rt.from); setFromQuery(rt.from.name);
    if (rt.to) { setToStation(rt.to); setToQuery(rt.to.name); }
    else { setToStation(null); setToQuery(""); }
    // Go immediately
    saveRecent(rt.from, rt.to);
    setRecent(getRecent());
    prevDepsRef.current = null;
    trackEvent("station_search", { station_code: rt.from.code, station_name: rt.from.name, destination_code: rt.to?.code || "", destination_name: rt.to?.name || "" });
    setScreen("board");
    loadDepartures(rt.from.code, rt.to?.code);
  };

  useEffect(() => {
    if (screen !== "board" || !fromStation) return;
    let elapsed = 0;
    pctRef.current = setInterval(() => { elapsed += 1000; setRefreshPct(Math.min((elapsed / REFRESH_INTERVAL) * 100, 100)); }, 1000);
    timerRef.current = setInterval(() => { elapsed = 0; setRefreshPct(0); loadDepartures(fromStation.code, toStation?.code); }, REFRESH_INTERVAL);
    return () => { clearInterval(timerRef.current); clearInterval(pctRef.current); };
  }, [screen, fromStation, toStation, loadDepartures]);

  const goBack = () => {
    setScreen("search"); setDeps(null); setAllSvcs([]); setError(null); setToasts([]);
    clearInterval(timerRef.current); clearInterval(pctRef.current);
    prevDepsRef.current = null;
    setTimeout(() => fromRef.current?.focus(), 100);
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

            <div className="search-fields">
              <div className="field-wrap">
                <div className="search-icon"><SearchIcon/></div>
                <input ref={fromRef} className="search-input" placeholder="Departing from?"
                  value={fromQuery} onChange={e => { setFromQuery(e.target.value); setFromStation(null); }}
                  onFocus={() => { if (fromFiltered.length) setShowFromDrop(true); }}
                  onBlur={() => setTimeout(() => setShowFromDrop(false), 200)}
                  autoComplete="off" aria-label="Departure station"/>
                {showFromDrop && fromFiltered.length > 0 && (
                  <div className="dropdown" role="listbox">
                    {fromFiltered.map(s => (
                      <div key={s.code} className="dropdown-item" role="option" onMouseDown={() => selectFrom(s)}>
                        <span className="dropdown-name">{s.name}</span>
                        <span className="dropdown-code">{s.code}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="field-wrap">
                <div className="search-icon"><ArrowIcon/></div>
                <input className="search-input search-input-sm" placeholder="Going to? (optional)"
                  value={toQuery} onChange={e => { setToQuery(e.target.value); setToStation(null); }}
                  onFocus={() => { if (toFiltered.length) setShowToDrop(true); }}
                  onBlur={() => setTimeout(() => setShowToDrop(false), 200)}
                  autoComplete="off" aria-label="Destination station (optional)"/>
                {!toQuery && <span className="dest-optional">optional</span>}
                {toStation && <button className="clear-dest" onMouseDown={e => { e.preventDefault(); setToStation(null); setToQuery(""); }}>Clear</button>}
                {showToDrop && toFiltered.length > 0 && (
                  <div className="dropdown" role="listbox">
                    {toFiltered.map(s => (
                      <div key={s.code} className="dropdown-item" role="option" onMouseDown={() => selectTo(s)}>
                        <span className="dropdown-name">{s.name}</span>
                        <span className="dropdown-code">{s.code}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button className="go-btn" disabled={!fromStation} onClick={go}>
                {fromStation ? (toStation ? `Show trains to ${toStation.name}` : `Show departures from ${fromStation.name}`) : "Select a station"}
              </button>
            </div>

            {recent.length > 0 && !fromQuery && !toQuery && (
              <div className="recent-section">
                <div className="recent-label">Recent</div>
                <div className="recent-list">
                  {recent.map((rt, i) => (
                    <div key={i} className="recent-btn" role="button" tabIndex={0}
                      onClick={() => selectRecent(rt)} onKeyDown={e => e.key === "Enter" && selectRecent(rt)}>
                      <div className="recent-route">
                        <span className="recent-from">{rt.from.name}</span>
                        {rt.to && <span className="recent-to">to {rt.to.name}</span>}
                      </div>
                      <div className="recent-codes">
                        <span className="recent-code">{rt.from.code}</span>
                        {rt.to && <span className="recent-code">{rt.to.code}</span>}
                      </div>
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
                <div className="header-title">
                  <span className="station-name">{fromStation?.name}</span>
                  {toStation && <span className="route-to">to {toStation.name}</span>}
                </div>
                <span className="header-clock">{clock}</span>
              </div>
              <div className="header-row2">
                <span className="header-sub">{lastUpText ? `Updated ${lastUpText}` : "Loading\u2026"}</span>
                <div className="header-actions">
                  <button className="live-pill" onClick={() => fromStation && loadDepartures(fromStation.code, toStation?.code)} aria-label="Refresh departures">
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
              <div className="error-wrap"><div className="error-msg">Unable to load departures</div><button className="retry-btn" onClick={() => fromStation && loadDepartures(fromStation.code, toStation?.code)}>Retry</button></div>
            )}
            {!loading && !error && deps && deps.length === 0 && (
              <div className="empty-wrap"><div className="empty-icon">{"\uD83D\uDE89"}</div><div className="empty-text">{toStation ? `No trains to ${toStation.name} in the next hour` : "No departures in the next hour"}</div></div>
            )}
            {deps && deps.length > 0 && (
              <>
                <CompactLegend/>
                <div className="card-list" role="list" aria-label="Departures">
                  {deps.map((svc, i) => <DepartureCard key={i} svc={svc} allServices={allSvcs} stationCode={fromStation?.code}/>)}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
