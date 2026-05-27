/* ── XML-RPC helpers ── */

function toXml(v) {
  if (v === null || v === undefined) return '<value><boolean>0</boolean></value>';
  if (typeof v === 'boolean')  return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === 'number' && Number.isInteger(v)) return `<value><int>${v}</int></value>`;
  if (typeof v === 'number')   return `<value><double>${v}</double></value>`;
  if (typeof v === 'string')   return `<value><string>${v.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</string></value>`;
  if (Array.isArray(v))        return `<value><array><data>${v.map(toXml).join('')}</data></array></value>`;
  if (typeof v === 'object') {
    const members = Object.entries(v)
      .map(([k, val]) => `<member><name>${k}</name>${toXml(val)}</member>`)
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${String(v)}</string></value>`;
}

function buildCall(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${
    params.map(p => `<param>${toXml(p)}</param>`).join('')
  }</params></methodCall>`;
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : null;
}

function splitTopValues(xml) {
  const results = [];
  let i = 0;
  while (i < xml.length) {
    const start = xml.indexOf('<value>', i);
    if (start === -1) break;
    let depth = 0, j = start;
    while (j < xml.length) {
      if (xml.startsWith('<value>', j))   { depth++; j += 7; }
      else if (xml.startsWith('</value>', j)) { depth--; j += 8; if (depth === 0) break; }
      else j++;
    }
    results.push(xml.slice(start, j));
    i = j;
  }
  return results;
}

function parseValue(xml) {
  xml = xml.trim();
  if (xml.startsWith('<value>')) xml = xml.slice(7, xml.lastIndexOf('</value>')).trim();
  if (!xml.startsWith('<'))
    return xml.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  if (xml.startsWith('<string>'))
    return xml.slice(8, xml.indexOf('</string>')).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  if (xml.startsWith('<int>') || xml.startsWith('<i4>')) {
    const m = xml.match(/<i(?:nt|4)>(.*?)<\/i(?:nt|4)>/); return m ? parseInt(m[1]) : 0;
  }
  if (xml.startsWith('<double>')) {
    const m = xml.match(/<double>(.*?)<\/double>/); return m ? parseFloat(m[1]) : 0;
  }
  if (xml.startsWith('<boolean>')) {
    const m = xml.match(/<boolean>(.*?)<\/boolean>/); return m ? m[1].trim() === '1' : false;
  }
  if (xml.startsWith('<nil/>') || xml.startsWith('<nil />')) return null;
  if (xml.startsWith('<array>')) {
    const dataStart = xml.indexOf('<data>') + 6;
    const dataEnd   = xml.lastIndexOf('</data>');
    if (dataStart === -1 || dataEnd === -1) return [];
    return splitTopValues(xml.slice(dataStart, dataEnd)).map(parseValue);
  }
  if (xml.startsWith('<struct>')) {
    const obj = {};
    let rest = xml.slice(8, xml.lastIndexOf('</struct>'));
    let idx = 0;
    while (idx < rest.length) {
      const ms = rest.indexOf('<member>', idx);
      if (ms === -1) break;
      const me = rest.indexOf('</member>', ms);
      const member = rest.slice(ms + 8, me);
      const nameMatch = member.match(/<name>(.*?)<\/name>/);
      if (nameMatch) {
        const nameEnd = member.indexOf('</name>') + 7;
        obj[nameMatch[1]] = parseValue(member.slice(nameEnd).trim());
      }
      idx = me + 9;
    }
    return obj;
  }
  return xml;
}

function parseXml(text) {
  if (text.includes('<fault>')) {
    const msg = extractTag(text, 'string') || 'XML-RPC fault';
    throw new Error(msg);
  }
  const paramStart = text.indexOf('<param>');
  if (paramStart === -1) throw new Error('Respuesta XML-RPC inválida');
  const inner = text.slice(paramStart + 7, text.lastIndexOf('</param>'));
  return parseValue(inner.trim());
}

async function xmlRpc(baseUrl, endpoint, method, params) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildCall(method, params),
  });
  return parseXml(await res.text());
}

/* ── Cached auth (persists within warm Vercel instance) ── */
let cachedUid = null;
let authPromise = null;

async function getUid(ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_KEY) {
  if (cachedUid) return cachedUid;
  if (!authPromise) {
    authPromise = (async () => {
      const uid = await xmlRpc(ODOO_URL, '/xmlrpc/2/common', 'authenticate',
        [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
      if (!uid || uid === false || uid === 0)
        throw new Error('Autenticación fallida. Verificá las variables de entorno en Vercel.');
      cachedUid = uid;
      authPromise = null;
      return uid;
    })().catch(err => { authPromise = null; throw err; });
  }
  return authPromise;
}

/* ── Vercel handler ── */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ODOO_URL   = (process.env.ODOO_URL   || '').replace(/\/$/, '');
  const ODOO_KEY   = process.env.ODOO_KEY   || '';
  const ODOO_DB    = process.env.ODOO_DB    || '';
  const ODOO_LOGIN = process.env.ODOO_LOGIN || '';

  if (!ODOO_URL || !ODOO_KEY || !ODOO_DB || !ODOO_LOGIN) {
    return res.status(500).json({ error: 'Faltan variables de entorno en Vercel (ODOO_URL, ODOO_KEY, ODOO_DB, ODOO_LOGIN).' });
  }

  try {
    const { params } = req.body;
    const { model, method, args, kwargs } = params;
    const ctx = { lang:'es_AR', tz:'America/Argentina/Mendoza', ...(kwargs?.context || {}) };

    const uid = await getUid(ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_KEY);
    const result = await xmlRpc(ODOO_URL, '/xmlrpc/2/object', 'execute_kw',
      [ODOO_DB, uid, ODOO_KEY, model, method, args || [], { ...kwargs, context: ctx }]);

    return res.status(200).json({ result });
  } catch (err) {
    cachedUid = null; // reset so next request re-authenticates
    return res.status(502).json({ error: err.message });
  }
};
