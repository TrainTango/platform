import { useState, useEffect, useRef, useCallback } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";

const API_BASE = "/api";
const REFRESH_INTERVAL = 30000;
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_KEY);

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
  "Lumo": { confidence: "hint", coaches: null, short: "Very limited unreserved seats \u2014 look for green lights above seats.", cardLabel: "\uD83D\uDCA1 Limited unreserved", verified: "Mar 2026" },
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

// ── Platform Messaging ──
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
  if (confirmed) return { title: isChanged ? `Platform changed to ${platNum} \u2014 board now` : `Your train is at Platform ${platNum}`, description: isChanged ? "Confirmed via live data. This is your train \u2014 board now." : "This is your train \u2014 board now.", icon: isChanged ? "\u26A0\uFE0F" : "\u2705", cardLabel: isChanged ? "Changed" : "Board now", tier: "board", tipClass: isChanged ? "tip-platform-changed" : "tip-platform" };
  const effective = dep?.realtimeForecast || dep?.scheduleAdvertised;
  const minsOut = effective ? Math.round((new Date(effective) - new Date()) / 60000) : null;
  const likelyHere = minsOut !== null && minsOut <= 3;
  if (likelyHere) return { title: isChanged ? `Platform changed to ${platNum} \u2014 check train` : `Platform ${platNum} \u2014 check train`, description: "Your train is likely here. Check the destination on the train before boarding.", icon: isChanged ? "\u26A0\uFE0F" : "\uD83D\uDFE1", cardLabel: "Check train", tier: "go-caution", tipClass: isChanged ? "tip-platform-changed" : "tip-platform" };
  const { occupied } = checkPlatformOccupancy(userService, allServices);
  if (occupied) return { title: isChanged ? `Platform changed to ${platNum} \u2014 check train` : `Platform ${platNum} \u2014 another train there now`, description: "A different service is at this platform. Check the destination on the train before boarding.", icon: "\uD83D\uDFE1", cardLabel: "Check train", tier: "go-caution", tipClass: isChanged ? "tip-platform-changed" : "tip-platform" };
  return { title: isChanged ? `Platform changed to ${platNum} \u2014 head there now` : `Platform ${platNum} confirmed \u2014 head there now`, description: "Get there early and be first to board.", icon: isChanged ? "\u26A0\uFE0F" : "\u2705", cardLabel: isChanged ? "Changed" : "Confirmed", tier: "go", tipClass: isChanged ? "tip-platform-changed" : "tip-platform" };
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
  .card-list{padding:6px 10px 80px;display:flex;flex-direction:column;gap:6px}
  .dep-card{background:var(--bg-card);border-radius:12px;border-left:3.5px solid;display:grid;grid-template-columns:56px 1fr auto;gap:4px 10px;padding:12px 12px 12px 12px;align-items:center;cursor:pointer;transition:background .15s}
  .dep-card:hover{background:var(--bg-card-hover)}
  .dep-card.on-time{border-left-color:var(--green)}
  .dep-card.delayed{border-left-color:var(--amber)}
  .dep-card.cancelled{border-left-color:var(--red);opacity:.55}
  .countdown-col{display:flex;flex-direction:column;align-items:center;min-width:48px}
  .countdown-num{font-size:26px;font-weight:900;letter-spacing:-1px;line-height:1;font-variant-numeric:tabular-nums}
  .countdown-due{font-size:18px;font-weight:900;color:var(--green)}
  .countdown-unit{font-size:11px;font-weight:600;color:var(--text-dim);margin-top:1px}
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

  /* ── Feedback FAB (bottom-left) ── */
  .fab{position:fixed;bottom:24px;left:max(20px,calc((100vw - 480px) / 2 + 20px));width:44px;height:44px;border-radius:50%;background:var(--bg-card);border:1.5px solid var(--border);box-shadow:0 4px 16px var(--shadow);cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text-dim);z-index:90;transition:transform .2s,box-shadow .2s,border-color .2s,color .2s}
  .fab:hover{transform:scale(1.1);box-shadow:0 6px 24px var(--shadow);border-color:var(--accent);color:var(--accent)}
  .fab:active{transform:scale(.96)}

  /* ── Feedback modal ── */
  .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:flex;align-items:flex-end;justify-content:center;animation:fadeOverlay .2s ease-out}
  @keyframes fadeOverlay{from{opacity:0}to{opacity:1}}
  .modal{width:100%;max-width:480px;background:var(--bg-card);border-radius:20px 20px 0 0;padding:12px 20px 40px;animation:slideUp .28s cubic-bezier(.32,1.1,.5,1)}
  @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
  .modal-handle{width:36px;height:4px;background:var(--border-light);border-radius:2px;margin:0 auto 18px}
  .modal-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
  .modal-title{font-size:18px;font-weight:800;color:var(--text);letter-spacing:-.3px}
  .modal-close{background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:20px;padding:4px;line-height:1;border-radius:6px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center}
  .modal-close:hover{color:var(--text);background:var(--bg-input)}
  .modal-sub{font-size:13px;color:var(--text-muted);margin-bottom:20px;line-height:1.4}
  .rating-row{display:flex;gap:8px;margin-bottom:16px}
  .rating-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 12px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:12px;cursor:pointer;font-family:inherit;transition:border-color .15s,background .15s;min-height:72px}
  .rating-btn:hover{border-color:var(--accent);background:var(--accent-dim)}
  .rating-btn.selected-yes{border-color:var(--green);background:rgba(16,185,129,.08)}
  .rating-btn.selected-no{border-color:var(--amber);background:rgba(245,158,11,.08)}
  .rating-emoji{font-size:24px;line-height:1}
  .rating-label{font-size:12px;font-weight:600;color:var(--text-muted)}
  .rating-btn.selected-yes .rating-label{color:var(--green)}
  .rating-btn.selected-no .rating-label{color:var(--amber)}
  .comment-label{font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px;display:block}
  .comment-input{width:100%;padding:12px 14px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-size:14px;font-family:inherit;resize:none;outline:none;line-height:1.5;transition:border-color .2s,box-shadow .2s;margin-bottom:14px}
  .comment-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.12)}
  .comment-input::placeholder{color:var(--text-dim)}
  .submit-btn{width:100%;padding:13px;background:var(--accent);color:#fff;border:none;border-radius:11px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;transition:opacity .2s}
  .submit-btn:hover{opacity:.9}
  .submit-btn:disabled{opacity:.35;cursor:default}
  .modal-done{display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px 0 8px;text-align:center}
  .modal-done-icon{font-size:44px}
  .modal-done-title{font-size:17px;font-weight:800;color:var(--text)}
  .modal-done-sub{font-size:13px;color:var(--text-muted);line-height:1.5;max-width:260px}

  /* ── Donation widget ── */
  .donate-fab{position:fixed;bottom:24px;right:max(20px,calc((100vw - 480px) / 2 + 20px));width:44px;height:44px;border-radius:50%;background:#5F7FFF;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;z-index:90;box-shadow:0 4px 20px rgba(95,127,255,.45);transition:transform .2s,box-shadow .2s}
  .donate-fab:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(95,127,255,.55)}
  .donate-fab:active{transform:scale(.95)}
  .donate-tooltip{position:fixed;bottom:78px;right:max(20px,calc((100vw - 480px) / 2 + 20px));background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:11px 14px;font-size:13px;color:var(--text);max-width:210px;box-shadow:0 4px 16px var(--shadow);z-index:89;animation:toastIn .3s ease-out;line-height:1.4}
  .donate-tooltip::after{content:'';position:absolute;bottom:-7px;right:14px;width:12px;height:12px;background:var(--bg-card);border-right:1px solid var(--border);border-bottom:1px solid var(--border);transform:rotate(45deg)}
  .donate-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:flex;align-items:flex-end;justify-content:center;animation:fadeOverlay .2s ease-out}
  .donate-panel{width:100%;max-width:480px;background:var(--bg-card);border-radius:20px 20px 0 0;padding:12px 20px 40px;animation:slideUp .28s cubic-bezier(.32,1.1,.5,1);max-height:90vh;overflow-y:auto}
  .donate-handle{width:36px;height:4px;background:var(--border-light);border-radius:2px;margin:0 auto 16px}
  .donate-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
  .donate-title{font-size:17px;font-weight:800;color:var(--text);letter-spacing:-.3px}
  .donate-close{background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:20px;padding:4px;min-width:32px;min-height:32px;display:flex;align-items:center;justify-content:center;border-radius:6px}
  .donate-close:hover{color:var(--text);background:var(--bg-input)}
  .donate-amount-row{display:flex;gap:8px;margin-bottom:10px;align-items:stretch}
  .donate-amount-input-wrap{flex:1;display:flex;align-items:center;background:var(--bg-input);border:1.5px solid #5F7FFF;border-radius:10px;padding:0 12px}
  .donate-currency{font-size:16px;font-weight:700;color:var(--text);margin-right:10px}
  .donate-amount-input{flex:1;background:none;border:none;outline:none;font-size:14px;font-family:inherit;color:var(--text);padding:12px 0;width:0}
  .donate-amount-input::placeholder{color:var(--text-dim)}
  .donate-quick{padding:0 14px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:10px;font-size:14px;font-weight:700;color:var(--text-muted);cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap}
  .donate-quick:hover,.donate-quick.active{border-color:#5F7FFF;color:#5F7FFF;background:rgba(95,127,255,.08)}
  .donate-field{width:100%;padding:12px 14px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:10px;color:var(--text);font-size:14px;font-family:inherit;outline:none;margin-bottom:10px;transition:border-color .2s;display:block}
  .donate-field:focus{border-color:#5F7FFF}
  .donate-field::placeholder{color:var(--text-dim)}
  textarea.donate-field{resize:none;line-height:1.5}
  .donate-monthly{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-muted);margin-bottom:14px;cursor:pointer;user-select:none}
  .donate-monthly input[type=checkbox]{width:16px;height:16px;accent-color:#5F7FFF;cursor:pointer}
  .donate-error{font-size:12px;color:var(--red);margin-bottom:10px;padding:8px 12px;background:rgba(239,68,68,.08);border-radius:8px;border:1px solid rgba(239,68,68,.2)}
  .donate-submit-btn{width:100%;padding:14px;background:#5F7FFF;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;transition:opacity .2s;margin-bottom:12px;margin-top:4px}
  .donate-submit-btn:hover{opacity:.9}
  .donate-submit-btn:disabled{opacity:.4;cursor:default}
  .donate-stripe-badge{text-align:center;font-size:11px;color:var(--text-dim)}
  .donate-stripe-badge strong{color:var(--text-muted)}
  .donate-success{display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px 0;text-align:center}
  .donate-success-icon{font-size:52px}
  .donate-success-title{font-size:18px;font-weight:800;color:var(--text)}
  .donate-success-sub{font-size:13px;color:var(--text-muted);line-height:1.5;max-width:260px}
  `;
}

// ── Icons ──
const SearchIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const BackIcon  = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>;
const SunIcon   = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
const MoonIcon  = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z"/></svg>;
const ChatIcon  = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
const CoffeeIcon = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>;

// ── Feedback Modal ──
const PLACEHOLDERS = {
  yes: "What's working well? Any suggestions?",
  no:  "What could be better? We read every response.",
  null: "Any comments or suggestions? (optional)",
};

function FeedbackModal({ onClose }) {
  const [rating, setRating] = useState(null);
  const [comment, setComment] = useState("");
  const [done, setDone] = useState(false);

  function submit() {
    if (!rating) return;
    trackEvent("product_feedback", { rating, comment: comment.trim() });
    setDone(true);
    setTimeout(onClose, 2200);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-handle"/>
        {done ? (
          <div className="modal-done">
            <div className="modal-done-icon">🙏</div>
            <div className="modal-done-title">Thanks for the feedback</div>
            <div className="modal-done-sub">It genuinely helps us improve Platform for everyone.</div>
          </div>
        ) : (
          <>
            <div className="modal-header">
              <span className="modal-title">Share feedback</span>
              <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
            </div>
            <p className="modal-sub">Is Platform useful? Takes 20 seconds.</p>
            <div className="rating-row">
              <button className={`rating-btn ${rating === "yes" ? "selected-yes" : ""}`} onClick={() => setRating(r => r === "yes" ? null : "yes")}>
                <span className="rating-emoji">👍</span>
                <span className="rating-label">Yes, it helps</span>
              </button>
              <button className={`rating-btn ${rating === "no" ? "selected-no" : ""}`} onClick={() => setRating(r => r === "no" ? null : "no")}>
                <span className="rating-emoji">👎</span>
                <span className="rating-label">Needs work</span>
              </button>
            </div>
            <label className="comment-label" htmlFor="fb-comment">Comments</label>
            <textarea id="fb-comment" className="comment-input" rows={3} placeholder={PLACEHOLDERS[rating]} value={comment} onChange={e => setComment(e.target.value)}/>
            <button className="submit-btn" disabled={!rating} onClick={submit}>Send feedback</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Stripe payment form (step 2) ──
function DonationPaymentForm({ onSuccess }) {
  const stripe   = useStripe();
  const elements = useElements();
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setLoading(true); setError(null);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    });
    if (error) { setError(error.message); setLoading(false); }
    else onSuccess();
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement options={{ layout: "tabs" }}/>
      {error && <div className="donate-error" style={{marginTop:12}}>{error}</div>}
      <button type="submit" className="donate-submit-btn" disabled={!stripe || loading}>
        {loading ? "Processing…" : "Support"}
      </button>
      <div className="donate-stripe-badge">Powered by <strong>Stripe</strong></div>
    </form>
  );
}

// ── Donation Widget ──
function DonationWidget({ dark }) {
  const [open, setOpen]             = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [amount, setAmount]         = useState(3);      // selected quick amount
  const [customAmount, setCustomAmount] = useState(""); // typed amount
  const [monthly, setMonthly]       = useState(false);
  const [name, setName]             = useState("");
  const [message, setMessage]       = useState("");
  const [step, setStep]             = useState("form"); // "form" | "payment" | "success"
  const [clientSecret, setClientSecret] = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);

  const finalAmount = customAmount ? parseFloat(customAmount) : amount;

  // Show tooltip once after 3s, auto-hide after 5s
  useEffect(() => {
    const show = setTimeout(() => setShowTooltip(true), 3000);
    return () => clearTimeout(show);
  }, []);
  useEffect(() => {
    if (!showTooltip) return;
    const hide = setTimeout(() => setShowTooltip(false), 5000);
    return () => clearTimeout(hide);
  }, [showTooltip]);

  function handleOpen() { setOpen(true); setShowTooltip(false); }

  function handleClose() {
    setOpen(false);
    // Reset form if not mid-payment
    if (step !== "payment") {
      setStep("form"); setClientSecret(null); setError(null);
    }
  }

  async function handleContinue() {
    if (!finalAmount || finalAmount < 1) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/donate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: finalAmount, recurring: monthly, name, message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      setClientSecret(data.clientSecret);
      setStep("payment");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const stripeAppearance = {
    theme: dark ? "night" : "stripe",
    variables: { colorPrimary: "#5F7FFF", borderRadius: "10px", fontFamily: "Inter, system-ui, sans-serif" },
  };

  return (
    <>
      {showTooltip && !open && (
        <div className="donate-tooltip">
          Enjoying Platform? Help a Yorkshireman keep building
        </div>
      )}

      <button className="donate-fab" onClick={handleOpen} aria-label="Support this project">
        ❤️
      </button>

      {open && (
        <div className="donate-overlay" onClick={handleClose}>
          <div className="donate-panel" onClick={e => e.stopPropagation()}>
            <div className="donate-handle"/>

            {step === "success" && (
              <div className="donate-success">
                <div className="donate-success-icon">🍺</div>
                <div className="donate-success-title">Cheers! Much appreciated.</div>
                <div className="donate-success-sub">Keeps the tools running. Thanks for the support.</div>
              </div>
            )}

            {step === "payment" && clientSecret && (
              <>
                <div className="donate-header">
                  <span className="donate-title">Support Lawrence Byers</span>
                  <button className="donate-close" onClick={handleClose} aria-label="Close">✕</button>
                </div>
                <Elements stripe={stripePromise} options={{ clientSecret, appearance: stripeAppearance }}>
                  <DonationPaymentForm onSuccess={() => setStep("success")}/>
                </Elements>
              </>
            )}

            {step === "form" && (
              <>
                <div className="donate-header">
                  <span className="donate-title">Support Lawrence Byers</span>
                  <button className="donate-close" onClick={handleClose} aria-label="Close">✕</button>
                </div>

                {/* Amount */}
                <div className="donate-amount-row">
                  <div className="donate-amount-input-wrap">
                    <span className="donate-currency">£</span>
                    <input
                      className="donate-amount-input"
                      type="number" min="1" placeholder="Enter amount"
                      value={customAmount}
                      onChange={e => { setCustomAmount(e.target.value); setAmount(null); }}
                    />
                  </div>
                  <button className={`donate-quick ${amount === 3 && !customAmount ? "active" : ""}`}
                    onClick={() => { setAmount(3); setCustomAmount(""); }}>+£3</button>
                  <button className={`donate-quick ${amount === 5 && !customAmount ? "active" : ""}`}
                    onClick={() => { setAmount(5); setCustomAmount(""); }}>+£5</button>
                </div>

                {/* Name */}
                <input className="donate-field" placeholder="Name or @yoursocial" value={name} onChange={e => setName(e.target.value)}/>

                {/* Message */}
                <textarea className="donate-field" placeholder="Say something nice…" rows={3} value={message} onChange={e => setMessage(e.target.value)}/>

                {/* Monthly */}
                <label className="donate-monthly">
                  <input type="checkbox" checked={monthly} onChange={e => setMonthly(e.target.checked)}/>
                  Make this monthly
                </label>

                {error && <div className="donate-error">{error}</div>}

                <button className="donate-submit-btn" disabled={loading || !finalAmount || finalAmount < 1} onClick={handleContinue}>
                  {loading ? "Loading…" : "Support"}
                </button>
                <div className="donate-stripe-badge">Powered by <strong>Stripe</strong></div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── Departure Card ──
function DepartureCard({ svc, allServices }) {
  const [expanded, setExpanded] = useState(false);
  const status   = getStatus(svc);
  const plat     = getPlatform(svc);
  const dest     = getDestination(svc);
  const operator = getOperator(svc);
  const scheduled = getScheduledTime(svc);
  const effective = getEffectiveTime(svc);
  const mins     = minsUntil(effective);
  const isDelayed = status.key === "delayed";
  const vehicles  = svc.locationMetadata?.numberOfVehicles;
  const guidance  = getGuidance(operator, vehicles);
  const isNoReservation = NO_RESERVATION_OPERATORS.has(operator);
  const isCompulsory    = COMPULSORY_RESERVATION.has(operator);
  const reasons   = svc.reasons;
  const cancelReason = reasons?.find(r => r.type === "CANCEL")?.shortText || reasons?.find(r => r.type === "DELAY")?.shortText;
  const platMsg   = getPlatformMessage(svc, allServices);

  return (
    <div className={`dep-card ${status.key}`} role="button" tabIndex={0} aria-expanded={expanded}
      onClick={() => setExpanded(e => !e)} onKeyDown={e => e.key === "Enter" && setExpanded(x => !x)}>
      <div className="countdown-col">
        <span className="countdown-num">{fmtTime(scheduled)}</span>
        {mins !== null && mins > 0 ? <span className="countdown-unit">{mins} min</span>
          : mins === 0 ? <span className="countdown-due">Due</span> : null}
      </div>
      <div className="info-col">
        <span className="dest-name">{dest}</span>
        <div className="meta-row">
          <span className={`status-badge status-${status.key}`}>{status.label}</span>
          {status.key !== "cancelled" && guidance && (
            <span className={`coach-pill ${guidance.confidence === "hint" ? "coach-pill-hint" : ""}`}>{guidance.cardLabel}</span>
          )}
          {status.key !== "cancelled" && isNoReservation && <span className="coach-pill coach-pill-free">{"\u2705"} No reservations</span>}
          {status.key !== "cancelled" && !guidance && !isNoReservation && !isCompulsory && <span className="coach-pill coach-pill-none">{"\u2139\uFE0F"} No seating info</span>}
          <span className="operator-name">{operator}{vehicles ? ` \u00B7 ${vehicles} coaches` : ""}</span>
        </div>
      </div>
      <div className="plat-col">
        <div className={`plat-badge plat-${plat.tier}`}>
          {plat.text}
          {plat.tier === "confirmed" && <span className="plat-badge-icon plat-icon-confirmed">{"\u2713"}</span>}
          {plat.tier === "changed"   && <span className="plat-badge-icon plat-icon-changed">!</span>}
          {plat.tier === "expected"  && <span className="plat-badge-icon plat-icon-expected">?</span>}
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
            <div className="tip-card tip-coach"><span className="tip-icon">{"\uD83D\uDCBA"}</span><div className="tip-content"><span className="tip-title">{guidance.short}</span></div></div>
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
            <div className="tip-card tip-free"><span className="tip-icon">{"\u2705"}</span><div className="tip-content"><span className="tip-title">No reservations — every seat is first come, first served.</span></div></div>
          )}
          {status.key !== "cancelled" && isCompulsory && (
            <div className="tip-card tip-hint"><span className="tip-icon">{"\u26A0\uFE0F"}</span><div className="tip-content"><span className="tip-title">Reservation required — check your booking for coach and seat.</span></div></div>
          )}
          {status.key !== "cancelled" && !guidance && !isNoReservation && !isCompulsory && (
            <div className="tip-card tip-hint"><span className="tip-icon">{"\u2139\uFE0F"}</span><div className="tip-content"><span className="tip-title">No seating info — look for unreserved seats when you get on the train.</span></div></div>
          )}
          {cancelReason && <div className="cancel-reason">Reason: {cancelReason}</div>}
          <div className="detail-row">
            <div className="detail-item"><span className="detail-label">Operator</span><span className="detail-value">{operator}</span></div>
            <div className="detail-item"><span className="detail-label">Scheduled</span><span className="detail-value">{fmtTime(scheduled)}</span></div>
            {isDelayed && <div className="detail-item"><span className="detail-label">Expected</span><span className="detail-value" style={{color:"var(--amber)"}}>{fmtTime(effective)}</span></div>}
            {vehicles && <div className="detail-item"><span className="detail-label">Coaches</span><span className="detail-value">{vehicles}</span></div>}
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
  const [screen, setScreen]     = useState("search");
  const [stations, setStations] = useState([]);
  const [query, setQuery]       = useState("");
  const [filtered, setFiltered] = useState([]);
  const [showDrop, setShowDrop] = useState(false);
  const [station, setStation]   = useState(null);
  const [deps, setDeps]         = useState(null);
  const [allSvcs, setAllSvcs]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [lastUpDate, setLastUpDate] = useState(null);
  const [lastUpText, setLastUpText] = useState("");
  const [clock, setClock]       = useState(nowHHMM());
  const [refreshPct, setRefreshPct] = useState(0);
  const [toasts, setToasts]     = useState([]);
  const [recent, setRecent]     = useState(getRecent);
  const [showFeedback, setShowFeedback]         = useState(false);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  const prevDepsRef = useRef(null);
  const timerRef    = useRef(null);
  const clockRef    = useRef(null);
  const pctRef      = useRef(null);
  const inputRef    = useRef(null);

  useEffect(() => {
    fetchStations().then(setStations).catch(err => console.error("Stations:", err));
    trackEvent("page_view");
  }, []);

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
      const key = svcKey(s), oldP = oldMap[key], newP = getPlatform(s);
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
      setAllSvcs(data.allServices);
      detectChanges(data.departures);
      setDeps(data.departures);
      const now = new Date();
      setLastUpDate(now); setLastUpText(relativeTime(now)); setRefreshPct(0);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [detectChanges]);

  const selectStation = useCallback((s) => {
    setStation(s); setQuery(""); setShowDrop(false);
    saveRecent(s); setRecent(getRecent());
    prevDepsRef.current = null;
    trackEvent("station_search", { station_code: s.code, station_name: s.name });
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
    setScreen("search"); setDeps(null); setAllSvcs([]); setError(null); setToasts([]);
    clearInterval(timerRef.current); clearInterval(pctRef.current);
    prevDepsRef.current = null;
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const dismissToast = id => setToasts(t => t.filter(x => x.id !== id));

  useEffect(() => {
    if (!toasts.length) return;
    const timer = setTimeout(() => setToasts(t => t.slice(1)), 8000);
    return () => clearTimeout(timer);
  }, [toasts]);

  return (
    <>
      <style>{getCSS(dark)}</style>
      <div className="app">

        {/* ── Toasts ── */}
        {toasts.length > 0 && (
          <div className="toast-wrap" role="alert" aria-live="assertive">
            {toasts.map(t => (
              <div className="toast" key={t.id}>
                <span className="toast-icon">{t.tier === "now-confirmed" ? "\u2705" : "\u26A0\uFE0F"}</span>
                {t.tier === "now-confirmed"
                  ? <span>Platform {t.plat} now <strong>confirmed</strong> for {t.dest}</span>
                  : <span>Platform changed to <strong>{t.plat}</strong> for {t.dest}</span>}
                <button className="toast-close" onClick={() => dismissToast(t.id)}>{"\u2715"}</button>
              </div>
            ))}
          </div>
        )}

        {/* ── Feedback modal ── */}
        {showFeedback && <FeedbackModal onClose={() => { setShowFeedback(false); setFeedbackSubmitted(true); }}/>}

        {/* ── Feedback FAB (bottom-left) ── */}
        {!feedbackSubmitted && !showFeedback && (
          <button className="fab" aria-label="Share feedback" title="Share feedback" onClick={() => setShowFeedback(true)}>
            <ChatIcon/>
          </button>
        )}

        {/* ── Donation widget (bottom-right) ── */}
        <DonationWidget dark={dark}/>

        {/* ── Search screen ── */}
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
          </div>
        )}

        {/* ── Board screen ── */}
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
            {loading && !deps && <div className="loading-wrap"><div className="spinner"/><span style={{color:"var(--text-muted)",fontSize:14}}>Loading departures{"\u2026"}</span></div>}
            {error && <div className="error-wrap"><div className="error-msg">Unable to load departures</div><button className="retry-btn" onClick={() => station && loadDepartures(station.code)}>Retry</button></div>}
            {!loading && !error && deps && deps.length === 0 && <div className="empty-wrap"><div className="empty-icon">{"\uD83D\uDE89"}</div><div className="empty-text">No departures in the next hour</div></div>}
            {deps && deps.length > 0 && (
              <>
                <CompactLegend/>
                <div className="card-list" role="list" aria-label="Departures">
                  {deps.map((svc, i) => <DepartureCard key={i} svc={svc} allServices={allSvcs}/>)}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
