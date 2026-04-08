import { rttFetch } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const uid = req.query.uid;
  const identity = req.query.identity;
  const date = req.query.date;

  let path;
  if (uid) {
    path = `/gb-nr/service?uniqueIdentity=${encodeURIComponent(uid)}`;
  } else if (identity && date) {
    path = `/gb-nr/service?identity=${encodeURIComponent(identity)}&departureDate=${encodeURIComponent(date)}`;
  } else {
    return res.status(400).json({ error: 'Provide ?uid=... or ?identity=...&date=YYYY-MM-DD' });
  }

  try {
    const response = await rttFetch(path);
    if (!response.ok) throw new Error(`${response.status}`);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Service error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch service detail' });
  }
}
