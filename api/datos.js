import { db, autorizado, json } from '../lib/db.js';
import { asegurarEsquema, CONSULTAS } from '../lib/schema.js';

// GET /api/datos?v=compras&offset=0&limit=4000
export default async function handler(req, res) {
  const a = autorizado(req);
  if (!a.ok) return json(res, 401, { error: a.msg });
  try {
    const url = new URL(req.url, 'http://x');
    const v = url.searchParams.get('v');
    const pool = db();
    await asegurarEsquema(pool);

    if (v === 'estado') {
      const r = await pool.query(`SELECT fecha, detalle FROM cargas ORDER BY id DESC LIMIT 1`);
      return json(res, 200, { ultima: r.rows[0] || null, admin: a.admin });
    }
    const q = CONSULTAS[v];
    if (!q) return json(res, 400, { error: 'Vista desconocida' });
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
    const limit = Math.min(6000, Math.max(1, parseInt(url.searchParams.get('limit') || '4000', 10)));
    const [cnt, r] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM (${q}) t`),
      pool.query({ text: `${q} OFFSET $1 LIMIT $2`, values: [offset, limit], rowMode: 'array' }),
    ]);
    return json(res, 200, { total: cnt.rows[0].n, cols: r.fields.map(f => f.name), rows: r.rows });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
