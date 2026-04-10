const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_KEY;
const RTT_BASE = 'https://data.rtt.io';

// ── Auth (same pattern as departures.js) ────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
  const refreshToken = process.env.RTT_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('No RTT_REFRESH_TOKEN set');
  const res = await fetch(`${RTT_BASE}/api/get_access_token`, {
    headers: { Authorization: `Bearer ${refreshToken}` },
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.token;
  tokenExpiresAt = new Date(data.validUntil).getTime();
  return cachedToken;
}

// ── Supabase helpers ─────────────────────────────────────────────────────────
async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      ...options.headers,
    },
  });
  return res;
}

// ── RTT: look up actual departure platform for a service ────────────────────
async function fetchActualPlatform(serviceUid, scheduledDepart) {
  try {
    const token = await getAccessToken();

    // Parse date from scheduled_depart (ISO string stored in DB)
    const date = new Date(scheduledDepart);
    const yyyy = date.getUTCFullYear();
    const mm   = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(date.getUTCDate()).padStart(2, '0');

    // Strip any prefix like "gb-nr:" if present
    const uid = serviceUid.replace(/^gb-nr:/, '').split(':')[0];

    const url = `${RTT_BASE}/gb-nr/service/${uid}/${yyyy}/${mm}/${dd}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.log(`RTT service lookup failed for ${uid}: ${res.status}`);
      return null;
    }

    const data = await res.json();

    // RTT returns a list of stopping points — find the one matching our station
    // The actual departure platform is in the realtime data
    const locations = data.locations || [];
    for (const loc of locations) {
      const plat = loc.platform;
      if (plat?.actual) return plat.actual;
    }

    return null;
  } catch (err) {
    console.error('fetchActualPlatform error:', err.message);
    return null;
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Vercel cron jobs send an Authorization header with CRON_SECRET
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Find predictions where:
    // - actual_platform is still NULL (not yet reconciled)
    // - scheduled_depart was between 15 mins and 3 hours ago
    const now       = new Date();
    const fifteenMinsAgo = new Date(now - 15 * 60 * 1000).toISOString();
    const threeHoursAgo  = new Date(now - 3 * 60 * 60 * 1000).toISOString();

    const fetchRes = await supabaseFetch(
      `platform_predictions?actual_platform=is.null&scheduled_depart=gte.${threeHoursAgo}&scheduled_depart=lte.${fifteenMinsAgo}&select=id,service_uid,station_crs,scheduled_depart,predicted_platform`
    );

    if (!fetchRes.ok) {
      const err = await fetchRes.text();
      console.error('Supabase fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch predictions' });
    }

    const pending = await fetchRes.json();
    console.log(`Reconciling ${pending.length} predictions...`);

    let reconciled = 0;
    let notFound   = 0;

    for (const row of pending) {
      const actual = await fetchActualPlatform(row.service_uid, row.scheduled_depart);

      if (actual) {
        // Update the row with the actual platform
        await supabaseFetch(`platform_predictions?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            actual_platform: actual,
            confirmed_at: now.toISOString(),
          }),
        });
        console.log(`✓ ${row.service_uid} — predicted: ${row.predicted_platform}, actual: ${actual}`);
        reconciled++;
      } else {
        notFound++;
        console.log(`✗ ${row.service_uid} — no actual platform found`);
      }
    }

    return res.status(200).json({
      ok: true,
      total: pending.length,
      reconciled,
      not_found: notFound,
    });
  } catch (err) {
    console.error('Reconcile error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
