const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_KEY;

async function supabaseInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
  return res.ok;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    type, visitor_id,
    station_code, station_name,
    destination, operator, platform, platform_tier, seating_guidance,
    rating, comment,
    service_uid, station_crs, scheduled_depart, predicted_platform, predicted_tier,
  } = req.body || {};

  if (!type || !visitor_id) {
    return res.status(400).json({ error: 'Missing type or visitor_id' });
  }

  try {
    if (type === 'page_view') {
      await supabaseInsert('page_views', { visitor_id });

    } else if (type === 'station_search') {
      await supabaseInsert('station_searches', { visitor_id, station_code, station_name });

    } else if (type === 'feedback') {
      await supabaseInsert('feedback', { visitor_id, station_code, destination, operator, platform, platform_tier, seating_guidance });

    } else if (type === 'product_feedback') {
      const normalisedRating = rating === 'yes' || rating === 'up' || rating === 1 ? 'thumbs_up' : 'thumbs_down';
      await supabaseInsert('product_feedback', { visitor_id, rating: normalisedRating, comment: comment ?? null });

    } else if (type === 'platform_prediction') {
      await supabaseInsert('platform_predictions', { visitor_id, service_uid, station_crs, scheduled_depart, predicted_platform, predicted_tier });

    } else {
      return res.status(400).json({ error: 'Unknown type' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Analytics error:', err.message);
    return res.status(500).json({ error: 'Failed to log' });
  }
}
