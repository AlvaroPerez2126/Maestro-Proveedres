import { db, autorizar, json } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';
import { permiso } from './rendiciones.js';

// Respaldos (foto o PDF) de una línea de rendición
// POST   /api/respaldo?linea=ID   cuerpo = archivo (JPG/PNG/PDF, máx 4 MB), header x-nombre
// GET    /api/respaldo?id=ID      -> el archivo
// DELETE /api/respaldo?id=ID
export const config = { api: { bodyParser: false } };
const MAX = 4 * 1024 * 1024;

function tipoDe(buf) {
  const h = buf.subarray(0, 8);
  if (h.subarray(0, 4).toString('latin1') === '%PDF' || buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'pdf';
  if (h[0] === 0xFF && h[1] === 0xD8) return 'jpg';
  if (h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  return null;
}
async function leer(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const p = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX + 1024) throw Object.assign(new Error('El archivo supera 4 MB.'), { status: 413 }); p.push(c); }
  return Buffer.concat(p);
}
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };

export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req);
    if (!a.ok) return json(res, 401, { error: a.msg });
    if (!a.admin && !a.paginas.includes('rendiciones')) return json(res, 403, { error: 'No tienes acceso a Caja chica / Rendiciones.' });
    const u = new URL(req.url, 'http://x');

    if (req.method === 'POST') {
      const linea = parseInt(u.searchParams.get('linea') || '', 10);
      const l = await pool.query('SELECT rendicion_id FROM rendicion_lineas WHERE id=$1', [linea]);
      if (!l.rowCount) return json(res, 404, { error: 'La línea no existe (guarda la rendición primero).' });
      const p = await permiso(pool, a, l.rows[0].rendicion_id); if (!p.ok) return json(res, p.status, { error: p.msg });
      if (p.estado === 'cerrada') return json(res, 400, { error: 'La rendición está cerrada.' });
      const datos = await leer(req);
      if (datos.length > MAX) return json(res, 413, { error: 'El archivo supera 4 MB.' });
      const tipo = tipoDe(datos);
      if (!tipo) return json(res, 400, { error: 'Solo se aceptan fotos (JPG/PNG) o PDF.' });
      let nombre = ''; try { nombre = decodeURIComponent(req.headers['x-nombre'] || ''); } catch (e) {}
      nombre = (nombre || `respaldo.${tipo}`).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
      const r = await pool.query(`INSERT INTO rendicion_respaldos (linea_id, nombre, tipo, tam, datos, subido_por) VALUES ($1,$2,$3,$4,$5,$6)
                                  RETURNING id, linea_id, nombre, tipo, tam, subido_por, subido`, [linea, nombre, tipo, datos.length, datos, a.usuario]);
      await pool.query('UPDATE rendiciones SET actualizado=now() WHERE id=$1', [l.rows[0].rendicion_id]);
      return json(res, 200, { respaldo: r.rows[0] });
    }

    const id = parseInt(u.searchParams.get('id') || '', 10);
    const r = await pool.query(`SELECT r.nombre, r.tipo, ${req.method === 'GET' ? 'r.datos,' : ''} l.rendicion_id FROM rendicion_respaldos r JOIN rendicion_lineas l ON l.id = r.linea_id WHERE r.id=$1`, [id]);
    if (!r.rowCount) return json(res, 404, { error: 'El respaldo no existe.' });
    const p = await permiso(pool, a, r.rows[0].rendicion_id); if (!p.ok) return json(res, p.status, { error: p.msg });

    if (req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[r.rows[0].tipo] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=600');
      res.setHeader('x-tipo', r.rows[0].tipo);
      return res.end(r.rows[0].datos);
    }
    if (req.method === 'DELETE') {
      if (p.estado === 'cerrada') return json(res, 400, { error: 'La rendición está cerrada.' });
      await pool.query('DELETE FROM rendicion_respaldos WHERE id=$1', [id]);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Método no permitido' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
