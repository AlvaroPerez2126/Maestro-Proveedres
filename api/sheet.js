import { db, autorizar, json, empresaActiva } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';

// Asistencia contratista desde Google Sheets (se sincroniza sola)
// GET  /api/sheet                          -> configuración y última sincronización de la empresa activa
// POST /api/sheet {accion:'config', url}   -> guarda el enlace de la planilla (solo admin) y sincroniza
// POST /api/sheet {accion:'sync', forzar}  -> vuelve a leer la planilla (si pasaron más de 10 min, o forzar)
const CLAVE = 'asistencia';
const BASE = process.env.GSHEET_BASE || 'https://docs.google.com';
const MIN_ESPERA = 10 * 60 * 1000;

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Nombres de columna aceptados (encabezado normalizado)
const ALIAS = {
  trabajador: ['FIRSTNAME', 'NOMBRE', 'NOMBRES', 'TRABAJADOR', 'NAME', 'FULLNAME', 'NOMBRECOMPLETO'],
  apellido: ['LASTNAME', 'APELLIDO', 'APELLIDOS'],
  rut: ['RUT', 'EMAIL', 'DOCUMENTO', 'DNI', 'IDENTIFICACION'],
  contratista: ['COURSE', 'CONTRATISTA', 'CURSO', 'EMPRESA', 'PRESTADOR', 'PRESTADORDESERVICIOS'],
  fecha: ['DATE', 'FECHA', 'FECHAHORA', 'TIMESTAMP', 'MARCATEMPORAL', 'DATETIME'],
};

export function leerEnlace(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (!m) return null;
  const g = String(url).match(/[#&?]gid=(\d+)/);
  return { id: m[1], gid: g ? g[1] : null };
}

async function gviz(ref, tq) {
  const u = `${BASE}/spreadsheets/d/${ref.id}/gviz/tq?tqx=out:json&headers=1${ref.gid ? '&gid=' + ref.gid : ''}&tq=${encodeURIComponent(tq)}`;
  let r;
  try { r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 MaestroProveedores' }, signal: AbortSignal.timeout(45000) }); }
  catch (e) { const x = new Error('No pude conectar con Google Sheets (' + e.message + '). Intenta de nuevo en unos minutos.'); x.status = 502; throw x; }
  const txt = r.status === 200 ? await r.text() : '';
  const i = txt.indexOf('setResponse(');
  if (r.status !== 200 || i < 0) {
    const e = new Error('No pude leer la planilla de Google. Revisa que esté compartida como "Cualquier persona con el enlace" (Lector): en Google Sheets → Compartir → Acceso general.');
    e.status = 400; throw e;
  }
  const j = JSON.parse(txt.slice(i + 12, txt.lastIndexOf(')')));
  if (j.status === 'error') { const e = new Error((j.errors || []).map(x => x.detailed_message || x.message).join(' · ') || 'Error de Google Sheets'); e.gviz = true; throw e; }
  return j.table;
}

// Valor de celda gviz -> fecha 'AAAA-MM-DD'
function aFecha(c) {
  if (!c || c.v == null || c.v === '') return null;
  let m = typeof c.v === 'string' && c.v.match(/^Date\((\d+),(\d+),(\d+)/);
  if (m) return `${m[1]}-${String(+m[2] + 1).padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const s = String(c.v).trim();
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (typeof c.v === 'number' && c.v > 20000 && c.v < 80000) return new Date(Math.round((c.v - 25569) * 864e5)).toISOString().slice(0, 10);
  return null;
}
const txt = c => (c && c.v != null && String(c.v).trim() !== '') ? String(c.f ?? c.v).replace(/^'+/, '').trim() : null;
const RUT = /\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/;

export async function sincronizar(pool, emp, url, usuario) {
  const ref = leerEnlace(url);
  if (!ref) { const e = new Error('El enlace no es de una planilla de Google Sheets.'); e.status = 400; throw e; }
  // 1) Encabezados (letra de columna + nombre)
  const meta = await gviz(ref, 'select * limit 1');
  const cols = meta.cols.map(c => ({ id: c.id, label: c.label || '', k: norm(c.label), type: c.type }));
  const col = {};
  for (const [campo, al] of Object.entries(ALIAS)) { const c = al.map(a => cols.find(x => x.k === a)).find(Boolean); if (c) col[campo] = c; }
  if (!col.fecha || !col.contratista || !(col.trabajador || col.rut)) {
    const e = new Error('No encontré las columnas necesarias (Fecha/Date, Contratista/Course y First Name/Nombre). Columnas de la planilla: ' + cols.map(c => c.label || c.id).join(', '));
    e.status = 400; throw e;
  }
  const campos = ['trabajador', 'apellido', 'rut', 'contratista'].filter(k => col[k]);
  // 2) Pedir a Google las marcas ya agrupadas por trabajador + día (mucho más liviano); si falla, todo y se agrupa aquí
  const fechaSel = col.fecha.type === 'datetime' ? `toDate(${col.fecha.id})` : col.fecha.id;
  const grupo = [...campos.map(k => col[k].id), fechaSel];
  let tabla, agrupada = true;
  try { tabla = await gviz(ref, `select ${grupo.join(', ')}, count(${col.contratista.id}) where ${col.fecha.id} is not null group by ${grupo.join(', ')}`); }
  catch (e) { if (!e.gviz) throw e; agrupada = false; tabla = await gviz(ref, `select ${[...campos.map(k => col[k].id), col.fecha.id].join(', ')}`); }
  const acc = new Map();
  for (const r of tabla.rows || []) {
    const c = r.c || []; const o = {}; campos.forEach((k, i) => o[k] = txt(c[i]));
    const fecha = aFecha(c[campos.length]); if (!fecha || !o.contratista) continue;
    const n = agrupada ? (Number(c[campos.length + 1]?.v) || 1) : 1;
    let trab = o.trabajador || (o.rut ? o.rut.replace(RUT, '').replace(/@.*$/, '').trim() : null);
    if (o.apellido && trab && !trab.toUpperCase().includes(o.apellido.toUpperCase())) trab += ' ' + o.apellido;
    const rut = o.rut ? ((o.rut.match(RUT) || [])[0] || o.rut) : null;
    const k = [trab, rut, o.contratista, fecha].join('|');
    const x = acc.get(k); if (x) x.marcas += n; else acc.set(k, { trabajador: trab, rut, contratista: o.contratista, fecha, marcas: n });
  }
  const filas = [...acc.values()];
  if (!filas.length) { const e = new Error('La planilla no trae filas con fecha y contratista.'); e.status = 400; throw e; }
  // 3) Reemplazar los datos de la empresa
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query('DELETE FROM asis_contr WHERE empresa = $1', [emp]);
    for (let i = 0; i < filas.length; i += 5000)
      await cli.query(`INSERT INTO asis_contr (trabajador, rut, contratista, fecha, marcas, empresa)
        SELECT trabajador, rut, contratista, fecha, marcas, $2 FROM json_populate_recordset(NULL::asis_contr, $1::json)`, [JSON.stringify(filas.slice(i, i + 5000)), emp]);
    await cli.query(`INSERT INTO fuentes (empresa, clave, url, ultima, filas, error, actualizado_por) VALUES ($1, $2, $3, now(), $4, NULL, $5)
      ON CONFLICT (empresa, clave) DO UPDATE SET url = $3, ultima = now(), filas = $4, error = NULL, actualizado_por = $5`, [emp, CLAVE, url, filas.length, usuario]);
    await cli.query('COMMIT');
  } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
  return { filas: filas.length, marcas: filas.reduce((s, f) => s + f.marcas, 0), columnas: Object.fromEntries(Object.entries(col).map(([k, c]) => [k, c.label])) };
}

export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req);
    if (!a.ok) return json(res, 401, { error: a.msg });
    if (!a.admin && !a.paginas.includes('asiscontr')) return json(res, 403, { error: 'No tienes permiso para Asistencia contratista.' });
    const emp = await empresaActiva(req, a);
    const actual = async () => (await pool.query('SELECT url, ultima, filas, error, actualizado_por FROM fuentes WHERE empresa = $1 AND clave = $2', [emp, CLAVE])).rows[0] || null;

    if (req.method === 'GET') { const f = await actual(); if (f && !a.admin) delete f.url; return json(res, 200, { fuente: f }); }

    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    let url;
    if (b.accion === 'config') {
      if (!a.admin) return json(res, 403, { error: 'Solo un administrador puede cambiar la planilla.' });
      url = String(b.url || '').trim();
      if (!leerEnlace(url)) return json(res, 400, { error: 'Pega el enlace completo de Google Sheets (https://docs.google.com/spreadsheets/d/...).' });
    } else if (b.accion === 'sync') {
      const f = await actual();
      if (!f || !f.url) return json(res, 400, { error: 'Aún no se ha configurado la planilla de Google Sheets.' });
      if (!(b.forzar && a.admin) && f.ultima && Date.now() - new Date(f.ultima).getTime() < MIN_ESPERA) return json(res, 200, { ok: true, omitido: true, fuente: a.admin ? f : { ...f, url: undefined } });
      url = f.url;
    } else return json(res, 400, { error: 'Acción desconocida' });

    try {
      const r = await sincronizar(pool, emp, url, a.usuario);
      return json(res, 200, { ok: true, ...r, fuente: await actual() });
    } catch (e) {
      await pool.query(`INSERT INTO fuentes (empresa, clave, url, error) VALUES ($1, $2, $3, $4)
        ON CONFLICT (empresa, clave) DO UPDATE SET url = $3, error = $4`, [emp, CLAVE, url, e.message]);
      throw e;
    }
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
