import { useState, useEffect, useRef, useCallback } from "react";

const MOCK = false;
const API_BASE = "/api";
const REFRESH_INTERVAL = 30000;

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
  return r.json();
}

function parseTime(iso) {
  if (!iso) return null;
  return new Date(iso);
}

function fmtTime(iso) {
  const d = parseTime(iso);
  if (!d) return "--:--";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
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
  if (dep?.isCancelled) return { text: "N/A", tier: "cancelled", label: "" };
  if (!plat) return { text: "\u2014", tier: "unknown", label: "" };
  if (plat.actual) {
    const changed = plat.planned && plat.actual !== plat.planned;
    if (changed) return { text: plat.actual, tier: "changed", label: "Changed" };
    return { text: plat.actual, tier: "confirmed", label: "Confirmed" };
  }
  if (plat.planned) return { text: plat.planned, tier: "expected", label: "Expected" };
  return { text: "\u2014", tier: "unknown", label: "" };
}

function minsUntil(iso) {
  if (!iso) return "";
  const diff = Math.round((new Date(iso) - new Date()) / 60000);
  if (diff <= 0) return "Due";
  if (diff === 1) return "1 min";
  return `${diff} min`;
}

function nowHHMM() {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function getEffectiveTime(svc) {
  const dep = svc.temporalData?.departure;
  if (!dep) return null;
  return dep.realtimeForecast || dep.realtimeActual || dep.scheduleAdvertised;
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

function getHeadcode(svc) {
  return svc.scheduleMetadata?.trainReportingIdentity || "";
}

function getUid(svc) {
  return svc.scheduleMetadata?.uniqueIdentity || svc.scheduleMetadata?.identity || "";
}

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#090913;--bg-card:#101020;--bg-card-hover:#141428;--bg-input:#16162a;
    --accent:#6366f1;--accent-dim:rgba(99,102,241,0.12);
    --amber:#f59e0b;--green:#10b981;--red:#ef4444;--orange:#f97316;
    --text:#f1f5f9;--text-muted:#94a3b8;--text-dim:#475569;
    --border:#1e1e35;--border-light:#252542;
  }
  body,#root{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  .app{max-width:480px;margin:0 auto;min-height:100vh;position:relative}
  .search-screen{display:flex;flex-direction:column;align-items:center;padding:0 20px;padding-top:22vh;min-height:100vh}
  .logo{font-size:44px;font-weight:900;letter-spacing:-2px;background:linear-gradient(135deg,#6366f1 0%,#818cf8 50%,#a5b4fc 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
  .tagline{color:var(--text-dim);font-size:14px;font-weight:500;margin-bottom:40px;letter-spacing:.5px}
  .search-wrap{width:100%;position:relative}
  .search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--text-dim);pointer-events:none}
  .search-input{width:100%;padding:16px 16px 16px 48px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:14px;color:var(--text);font-size:16px;font-family:inherit;outline:none;transition:all .2s}
  .search-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(99,102,241,.15)}
  .search-input::placeholder{color:var(--text-dim)}
  .search-hint{color:var(--text-dim);font-size:12px;margin-top:12px;text-align:center}
  .dropdown{position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;z-index:50;max-height:320px;overflow-y:auto;box-shadow:0 20px 50px rgba(0,0,0,.6)}
  .dropdown-item{padding:13px 16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:background .15s;border-bottom:1px solid var(--border)}
  .dropdown-item:last-child{border-bottom:none}
  .dropdown-item:hover{background:rgba(99,102,241,.08)}
  .dropdown-name{font-size:14px;font-weight:500}
  .dropdown-code{font-size:11px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:3px 8px;border-radius:6px;letter-spacing:.5px}
  .board-screen{display:flex;flex-direction:column;min-height:100vh}
  .board-header{position:sticky;top:0;z-index:40;background:rgba(9,9,19,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);padding:12px 16px 0;border-bottom:1px solid var(--border)}
  .header-row1{display:flex;align-items:center;gap:10px}
  .back-btn{background:none;border:none;color:var(--text-muted);cursor:pointer;padding:6px;border-radius:8px;display:flex;align-items:center;transition:all .2s}
  .back-btn:hover{color:var(--text);background:rgba(255,255,255,.05)}
  .station-name{font-size:18px;font-weight:800;letter-spacing:-.5px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .header-clock{font-size:18px;font-weight:800;color:var(--accent);letter-spacing:-.5px;font-variant-numeric:tabular-nums}
  .header-row2{display:flex;align-items:center;justify-content:space-between;padding-left:36px;margin-top:4px}
  .header-sub{font-size:11px;color:var(--text-dim)}
  .live-pill{display:flex;align-items:center;gap:5px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);padding:3px 10px;border-radius:14px;cursor:pointer;font-size:10px;font-weight:700;color:var(--green);letter-spacing:.8px;text-transform:uppercase;transition:background .2s}
  .live-pill:hover{background:rgba(16,185,129,.15)}
  .live-dot{width:6px;height:6px;background:var(--green);border-radius:50%;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .refresh-bar{height:2px;background:var(--border);overflow:hidden}
  .refresh-fill{height:100%;background:var(--accent);transition:width 1s linear;border-radius:0 1px 1px 0}
  .card-list{padding:6px 10px 24px;display:flex;flex-direction:column;gap:6px}
  .dep-card{background:var(--bg-card);border-radius:12px;border-left:3px solid;display:grid;grid-template-columns:62px 1fr auto;gap:4px 10px;padding:12px 12px 12px 14px;align-items:center;cursor:pointer;transition:background .15s}
  .dep-card:hover{background:var(--bg-card-hover)}
  .dep-card.on-time{border-left-color:var(--green)}
  .dep-card.delayed{border-left-color:var(--amber)}
  .dep-card.cancelled{border-left-color:var(--red);opacity:.6}
  .time-col{display:flex;flex-direction:column;justify-content:center}
  .time-main{font-size:20px;font-weight:800;letter-spacing:-.5px;line-height:1.15;font-variant-numeric:tabular-nums}
  .time-struck{font-size:12px;font-weight:600;color:var(--text-dim);text-decoration:line-through;line-height:1}
  .time-actual{font-size:18px;font-weight:800;color:var(--amber);letter-spacing:-.5px;line-height:1.2;font-variant-numeric:tabular-nums}
  .time-eta{font-size:10px;color:var(--text-dim);font-weight:600;margin-top:1px;font-variant-numeric:tabular-nums}
  .info-col{display:flex;flex-direction:column;gap:2px;min-width:0}
  .dest-name{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
  .meta-row{display:flex;align-items:center;gap:6px;margin-top:2px;flex-wrap:wrap}
  .status-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;letter-spacing:.2px;text-transform:uppercase}
  .status-on-time{background:rgba(16,185,129,.1);color:var(--green)}
  .status-delayed{background:rgba(245,158,11,.1);color:var(--amber)}
  .status-cancelled{background:rgba(239,68,68,.1);color:var(--red)}
  .operator-name{font-size:10px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
  .vehicles-badge{font-size:10px;color:var(--text-dim);background:var(--bg-input);padding:2px 6px;border-radius:4px}
  .plat-col{display:flex;flex-direction:column;align-items:center;gap:3px;justify-self:end}
  .plat-badge{min-width:52px;height:52px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:22px;letter-spacing:-.5px;padding:0 6px;font-variant-numeric:tabular-nums;position:relative}
  .plat-confirmed{background:linear-gradient(140deg,#f59e0b,#d97706);color:#090913;box-shadow:0 0 18px rgba(245,158,11,.3),0 0 40px rgba(245,158,11,.08)}
  .plat-changed{background:linear-gradient(140deg,#f97316,#ea580c);color:#fff;box-shadow:0 0 18px rgba(249,115,22,.35);animation:platPulse 2s ease-in-out infinite}
  @keyframes platPulse{0%,100%{box-shadow:0 0 18px rgba(249,115,22,.35)}50%{box-shadow:0 0 24px rgba(249,115,22,.55),0 0 40px rgba(249,115,22,.15)}}
  .plat-expected{background:transparent;color:var(--amber);border:2px solid rgba(245,158,11,.35);font-size:20px}
  .plat-unknown{background:var(--bg-input);color:var(--text-dim);border:2px dashed var(--border-light);font-size:18px}
  .plat-cancelled{background:rgba(239,68,68,.08);color:rgba(239,68,68,.5);border:1.5px solid rgba(239,68,68,.15);font-size:12px;font-weight:700}
  .plat-label{font-size:9px;font-weight:700;letter-spacing:.4px;text-transform:uppercase}
  .plat-label-confirmed{color:var(--amber)}
  .plat-label-changed{color:var(--orange)}
  .plat-label-expected{color:var(--text-dim)}
  .changed-alert{display:flex;align-items:center;gap:4px;font-size:9px;font-weight:700;color:var(--orange);letter-spacing:.3px;text-transform:uppercase}
  .changed-icon{display:inline-flex;width:12px;height:12px;align-items:center;justify-content:center;background:rgba(249,115,22,.15);border-radius:50%;font-size:8px;flex-shrink:0}
  .expanded-area{grid-column:1/-1;padding-top:8px;margin-top:4px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px}
  .detail-grid{display:flex;gap:16px;flex-wrap:wrap}
  .detail-item{display:flex;flex-direction:column;gap:1px}
  .detail-label{font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
  .detail-value{font-size:12px;font-weight:600;color:var(--text-muted)}
  .detail-value-accent{font-size:12px;font-weight:700;color:var(--amber)}
  .cancel-reason{font-size:11px;color:var(--red);font-weight:500;font-style:italic}
  .confidence-row{display:flex;align-items:center;gap:8px}
  .conf-track{flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden}
  .conf-fill{height:100%;border-radius:2px;transition:width .3s}
  .conf-high{width:100%;background:var(--amber)}
  .conf-changed{width:90%;background:var(--orange)}
  .conf-med{width:50%;background:var(--text-dim)}
  .conf-low{width:8%;background:var(--border-light)}
  .conf-text{font-size:9px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
  .legend-toggle{display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;font-size:10px;color:var(--text-dim);cursor:pointer;font-weight:600;letter-spacing:.3px}
  .legend-toggle:hover{color:var(--text-muted)}
  .legend{margin:0 10px 8px;padding:12px 14px;background:var(--bg-card);border-radius:10px;border:1px solid var(--border);display:flex;flex-direction:column;gap:10px}
  .legend-title{font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px}
  .legend-row{display:flex;align-items:center;gap:10px}
  .legend-badge{width:34px;height:34px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0}
  .legend-desc{font-size:11px;color:var(--text-muted);line-height:1.35}
  .legend-desc strong{color:var(--text);font-weight:600}
  .loading-wrap,.error-wrap,.empty-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;text-align:center}
  .spinner{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;margin-bottom:14px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .error-msg{color:var(--red);font-weight:600;margin-bottom:16px;font-size:14px}
  .retry-btn{background:var(--accent);color:white;border:none;padding:10px 24px;border-radius:10px;font-weight:600;font-size:14px;font-family:inherit;cursor:pointer}
  .retry-btn:hover{opacity:.85}
  .empty-icon{font-size:32px;margin-bottom:10px;opacity:.4}
  .empty-text{color:var(--text-muted);font-size:13px}
`;

const SearchIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const BackIcon = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>;
const InfoIcon = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
const AlertIcon = () => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;

function DepartureCard({ svc }) {
  const [expanded, setExpanded] = useState(false);
  const status = getStatus(svc);
  const plat = getPlatform(svc);
  const dest = getDestination(svc);
  const operator = getOperator(svc);
  const headcode = getHeadcode(svc);
  const uid = getUid(svc);
  const isDelayed = status.key === "delayed";
  const scheduled = getScheduledTime(svc);
  const effective = getEffectiveTime(svc);
  const vehicles = svc.locationMetadata?.numberOfVehicles;
  const reasons = svc.reasons;
  const cancelReason = reasons?.find(r => r.type === "CANCEL")?.shortText
    || reasons?.find(r => r.type === "DELAY")?.shortText;
  const confClass = plat.tier === "confirmed" ? "high" : plat.tier === "changed" ? "changed" : plat.tier === "expected" ? "med" : "low";

  return (
    <div className={`dep-card ${status.key}`} onClick={() => setExpanded(e => !e)}>
      <div className="time-col">
        {isDelayed ? (
          <>
            <span className="time-struck">{fmtTime(scheduled)}</span>
            <span className="time-actual">{fmtTime(effective)}</span>
          </>
        ) : (
          <span className="time-main">{fmtTime(scheduled)}</span>
        )}
        <span className="time-eta">{minsUntil(effective)}</span>
      </div>
      <div className="info-col">
        <span className="dest-name">{dest}</span>
        <div className="meta-row">
          <span className={`status-badge status-${status.key}`}>{status.label}</span>
          <span className="operator-name">{operator}</span>
          {vehicles && <span className="vehicles-badge">{vehicles} coaches</span>}
        </div>
      </div>
      <div className="plat-col">
        <div className={`plat-badge plat-${plat.tier}`}>{plat.text}</div>
        {plat.tier === "changed" ? (
          <div className="changed-alert"><span className="changed-icon"><AlertIcon/></span> Changed</div>
        ) : plat.label ? (
          <span className={`plat-label plat-label-${plat.tier}`}>{plat.label}</span>
        ) : null}
      </div>
      {expanded && (
        <div className="expanded-area">
          {plat.tier !== "cancelled" && plat.tier !== "unknown" && (
            <div className="confidence-row">
              <div className="conf-track"><div className={`conf-fill conf-${confClass}`}/></div>
              <span className="conf-text">
                {plat.tier === "confirmed" ? "Platform confirmed" :
                 plat.tier === "changed" ? "Confirmed \u2014 changed from schedule" :
                 "Timetabled \u2014 not yet confirmed"}
              </span>
            </div>
          )}
          {cancelReason && <div className="cancel-reason">Reason: {cancelReason}</div>}
          <div className="detail-grid">
            <div className="detail-item">
              <span className="detail-label">Operator</span>
              <span className="detail-value">{operator}</span>
            </div>
            {headcode && <div className="detail-item">
              <span className="detail-label">Headcode</span>
              <span className="detail-value">{headcode}</span>
            </div>}
            {uid && <div className="detail-item">
              <span className="detail-label">UID</span>
              <span className="detail-value" style={{fontSize:10}}>{uid}</span>
            </div>}
            {plat.text !== "\u2014" && plat.text !== "N/A" && (
              <div className="detail-item">
                <span className="detail-label">Platform</span>
                <span className={plat.tier === "confirmed" || plat.tier === "changed" ? "detail-value-accent" : "detail-value"}>
                  {plat.text} {plat.tier === "confirmed" || plat.tier === "changed" ? "(live)" : "(timetabled)"}
                </span>
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
        <InfoIcon/> {open ? "Hide guide" : "Platform confidence guide"} {open ? "\u25B4" : "\u25BE"}
      </div>
      {open && (
        <div className="legend">
          <div className="legend-title">Platform Confidence</div>
          <div className="legend-row">
            <div className="legend-badge plat-confirmed" style={{fontSize:14}}>4</div>
            <div className="legend-desc"><strong>Confirmed</strong> — Live data. High confidence.</div>
          </div>
          <div className="legend-row">
            <div className="legend-badge plat-changed" style={{fontSize:14,color:"#fff"}}>7</div>
            <div className="legend-desc"><strong>Changed</strong> — Confirmed but differs from timetable.</div>
          </div>
          <div className="legend-row">
            <div className="legend-badge plat-expected" style={{fontSize:13}}>4</div>
            <div className="legend-desc"><strong>Expected</strong> — Timetabled, not yet confirmed.</div>
          </div>
          <div className="legend-row">
            <div className="legend-badge plat-unknown" style={{fontSize:13}}>{"\u2014"}</div>
            <div className="legend-desc"><strong>Unknown</strong> — No platform data yet.</div>
          </div>
        </div>
      )}
    </>
  );
}

export default function App() {
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

  const manualRefresh = () => { if (station) loadDepartures(station.code); };

  return (
    <>
      <style>{css}</style>
      <div className="app">
        {screen === "search" && (
          <div className="search-screen">
            <div className="logo">Platform</div>
            <div className="tagline">Know before you go</div>
            <div className="search-wrap">
              <div className="search-icon"><SearchIcon/></div>
              <input ref={inputRef} className="search-input" placeholder="Search station..."
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
            <div className="search-hint">Type a station name or CRS code</div>
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
                <span className="header-sub">{lastUp ? `Updated at ${lastUp}` : "Loading\u2026"}</span>
                <button className="live-pill" onClick={manualRefresh}>
                  <span className="live-dot"/>LIVE
                </button>
              </div>
              <div className="refresh-bar"><div className="refresh-fill" style={{width:`${refreshPct}%`}}/></div>
            </div>
            {loading && !deps && (
              <div className="loading-wrap"><div className="spinner"/><span style={{color:"var(--text-muted)",fontSize:14}}>Loading departures\u2026</span></div>
            )}
            {error && (
              <div className="error-wrap"><div className="error-msg">Unable to load departures</div><button className="retry-btn" onClick={manualRefresh}>Retry</button></div>
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
      </div>
    </>
  );
}
