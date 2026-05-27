module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const src = (req.url.match(/src=([^&]+)/) || [])[1] || '';
  const sheetUrl = src === 'resumen'    ? (process.env.SHEETS_RESUMEN_URL    || '')
                 : src === 'viajes'     ? (process.env.SHEETS_VIAJES_URL     || '')
                 : src === 'resumenlog' ? (process.env.SHEETS_RESUMENLOG_URL || '')
                 :                       (process.env.SHEETS_URL             || '');

  if (!sheetUrl) {
    const varName = src ? `SHEETS_${src.toUpperCase()}_URL` : 'SHEETS_URL';
    return res.status(500).json({ error: `Variable ${varName} no configurada en Vercel.` });
  }

  try {
    const r    = await fetch(sheetUrl);
    const body = await r.text();
    if (body.trimStart().startsWith('<') || body.includes('accounts.google.com')) {
      return res.status(403).json({ error: 'El Google Sheet no es público.' });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(body);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
