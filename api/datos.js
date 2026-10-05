import { db, autorizar, json, PAGINAS, empresasPermitidas, empresaActiva } from '../lib/db.js';
import { asegurarEsquema, CONSULTAS } from '../lib/schema.js';

// GET /api/datos?v=compras&offset=0&limit=4000
export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req);
    if (!a.ok) return json(res, 401, { error: a.msg });

    const url = new URL(req.url, 'http://x');
    const v = url.searchParams.get('v');
    // vistas de datos que este usuario puede leer (según sus páginas)
    const vistas = new Set(a.paginas.flatMap(p => [].concat(PAGINAS[p])));

    const emp = await empresaActiva(req, a);
    if (v === 'estado') {
      const r = await pool.query(`SELECT fecha, detalle FROM cargas WHERE empresa = $1 ORDER BY id DESC LIMIT 1`, [emp]);
      return json(res, 200, { ultima: r.rows[0] || null, usuario: a.usuario, nombre: a.nombre, admin: a.admin, paginas: a.paginas, vistas: [...vistas],
        empresa: emp, empresas: await empresasPermitidas(a) });
    }
    const q = CONSULTAS[v];
    if (!q) return json(res, 400, { error: 'Vista desconocida' });
    if (!vistas.has(v)) return json(res, 403, { error: 'No tienes permiso para ver estos datos.' });
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
    const limit = Math.min(6000, Math.max(1, parseInt(url.searchParams.get('limit') || '4000', 10)));
    const [cnt, r] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM (${q}) t`, [emp]),
      pool.query({ text: `${q} OFFSET $2 LIMIT $3`, values: [emp, offset, limit], rowMode: 'array' }),
    ]);
    return json(res, 200, { total: cnt.rows[0].n, cols: r.fields.map(f => f.name), rows: r.rows });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
