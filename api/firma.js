import { db, autorizar, json } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';

// Firma del usuario conectado (PNG con fondo transparente)
// GET    /api/firma          -> { tiene, actualizado }
// GET    /api/firma?img=1    -> la imagen PNG
// POST   /api/firma          cuerpo = PNG (máx. 600 KB)
// DELETE /api/firma
export const config = { api: { bodyParser: false } };
const MAX = 600 * 1024;

export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req);
    if (!a.ok) return json(res, 401, { error: a.msg });
    const u = new URL(req.url, 'http://x');

    if (req.method === 'GET') {
      const r = await pool.query('SELECT imagen, actualizado FROM firmas WHERE usuario=$1', [a.usuario]);
      if (u.searchParams.get('img')) {
        if (!r.rowCount) return json(res, 404, { error: 'Sin firma' });
        res.statusCode = 200; res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store');
        return res.end(r.rows[0].imagen);
      }
      return json(res, 200, { tiene: r.rowCount > 0, actualizado: r.rows[0]?.actualizado || null });
    }
    if (req.method === 'POST') {
      let datos;
      if (Buffer.isBuffer(req.body)) datos = req.body;
      else { const p = []; let n = 0; for await (const c of req) { n += c.length; if (n > MAX) return json(res, 413, { error: 'La firma es muy pesada.' }); p.push(c); } datos = Buffer.concat(p); }
      if (datos.length > MAX) return json(res, 413, { error: 'La firma es muy pesada.' });
      if (!(datos[0] === 0x89 && datos.subarray(1, 4).toString('latin1') === 'PNG')) return json(res, 400, { error: 'Formato de firma inválido.' });
      await pool.query(`INSERT INTO firmas (usuario, imagen) VALUES ($1,$2) ON CONFLICT (usuario) DO UPDATE SET imagen=EXCLUDED.imagen, actualizado=now()`, [a.usuario, datos]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      await pool.query('DELETE FROM firmas WHERE usuario=$1', [a.usuario]);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Método no permitido' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
