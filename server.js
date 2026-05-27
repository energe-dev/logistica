const http = require('http');
const fs   = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const [key, ...rest] = line.split('=');
      if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    });
}

const ODOO_URL   = (process.env.ODOO_URL   || '').replace(/\/$/, '');
const ODOO_KEY   = process.env.ODOO_KEY   || '';
const ODOO_DB    = process.env.ODOO_DB    || '';
const ODOO_LOGIN = process.env.ODOO_LOGIN || '';

console.log('ODOO_URL:  ', ODOO_URL   || '(vacío)');
console.log('ODOO_KEY:  ', ODOO_KEY   ? '✓ cargado' : '(vacío)');
console.log('ODOO_DB:   ', ODOO_DB    || '(vacío)');
console.log('ODOO_LOGIN:', ODOO_LOGIN || '(vacío)');

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

function parseXml(text) {
  if (text.includes('<fault>')) {
    const msg = extractTag(text, 'string') || extractTag(text, 'faultString') || 'XML-RPC fault';
    throw new Error(msg);
  }
  const paramStart = text.indexOf('<param>');
  if (paramStart === -1) throw new Error('Respuesta XML-RPC inválida:\n' + text.slice(0, 300));
  const inner = text.slice(paramStart + 7, text.lastIndexOf('</param>'));
  return parseValue(inner.trim());
}

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1] : null;
}

// Find matching top-level <value>...</value> blocks (handles nesting)
function splitTopValues(xml) {
  const results = [];
  let i = 0;
  while (i < xml.length) {
    const start = xml.indexOf('<value>', i);
    if (start === -1) break;
    let depth = 0, j = start;
    while (j < xml.length) {
      if (xml.startsWith('<value>', j))  { depth++; j += 7; }
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

  if (!xml.startsWith('<')) {
    // bare string
    return xml.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  }
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
        const valPart = member.slice(nameEnd).trim();
        obj[nameMatch[1]] = parseValue(valPart);
      }
      idx = me + 9;
    }
    return obj;
  }
  return xml;
}

async function xmlRpc(endpoint, method, params) {
  const res = await fetch(`${ODOO_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildCall(method, params),
  });
  const text = await res.text();
  return parseXml(text);
}

// Cached uid + singleton auth promise to avoid parallel auth calls
let cachedUid = null;
let authPromise = null;

async function getUid() {
  if (cachedUid) return cachedUid;
  if (!authPromise) {
    authPromise = (async () => {
      console.log('  → Autenticando via XML-RPC...');
      const uid = await xmlRpc('/xmlrpc/2/common', 'authenticate',
        [ODOO_DB, ODOO_LOGIN, ODOO_KEY, {}]);
      if (!uid || uid === false || uid === 0) {
        throw new Error('Autenticación fallida. Verificá ODOO_DB, ODOO_LOGIN y ODOO_KEY en .env');
      }
      console.log(`  ✓ Autenticado (uid: ${uid})`);
      cachedUid = uid;
      authPromise = null;
      return uid;
    })().catch(err => { authPromise = null; throw err; });
  }
  return authPromise;
}

async function odooCall(model, method, args, kwargs) {
  const uid = await getUid();
  try {
    return await xmlRpc('/xmlrpc/2/object', 'execute_kw',
      [ODOO_DB, uid, ODOO_KEY, model, method, args, kwargs]);
  } catch (err) {
    // Reset uid on any Odoo error so next request re-authenticates
    cachedUid = null;
    throw err;
  }
}

/* ── HTTP server ── */

const server = http.createServer(async (req, res) => {

  if (req.method === 'POST' && req.url === '/api/odoo') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      console.log('\n→ /api/odoo llamado');
      if (!ODOO_URL || !ODOO_KEY || !ODOO_DB || !ODOO_LOGIN) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Faltan variables en .env' }));
      }
      try {
        const { params } = JSON.parse(body);
        const { model, method, args, kwargs } = params;
        const ctx = { lang:'es_AR', tz:'America/Argentina/Mendoza', ...(kwargs?.context||{}) };
        const result = await odooCall(model, method, args || [], { ...kwargs, context: ctx });
        console.log('  ✓ OK');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result }));
      } catch (err) {
        console.log('  ✗ Error completo:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/sheets')) {
    const src = (req.url.match(/src=([^&]+)/) || [])[1] || '';
    const sheetUrl = src === 'resumen'    ? (process.env.SHEETS_RESUMEN_URL    || '')
                   : src === 'viajes'     ? (process.env.SHEETS_VIAJES_URL     || '')
                   : src === 'resumenlog' ? (process.env.SHEETS_RESUMENLOG_URL || '')
                   :                       (process.env.SHEETS_URL             || '');
    if (!sheetUrl) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `SHEETS_${src.toUpperCase() || 'URL'} no configurada en .env` }));
    }
    try {
      const r = await fetch(sheetUrl);
      const body = await r.text();
      if (body.trimStart().startsWith('<') || body.includes('accounts.google.com')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'El Google Sheet no es público.' }));
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      return res.end(body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`\n  Servidor corriendo en http://localhost:${PORT}\n`);
});
