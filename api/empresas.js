import { db, autorizar, json } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';

// Empresas del holding (solo administradores)
// GET  /api/empresas                       -> lista con cantidad de datos por empresa
// POST /api/empresas {id?, nombre, rut, codigo, area, orden, activo}
export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req, { admin: true });
    if (!a.ok) return json(res, 401, { error: a.msg });
    if (req.method === 'GET') {
      const r = await pool.query(`SELECT e.*,
          (SELECT count(*)::int FROM compras c WHERE c.empresa = e.id) AS compras,
          (SELECT count(*)::int FROM cruce_sii s WHERE s.empresa = e.id) AS cruce,
          (SELECT count(*)::int FROM rendiciones r WHERE r.empresa = e.id) AS rendiciones,
          (SELECT max(fecha) FROM cargas g WHERE g.empresa = e.id) AS ultima_carga
        FROM empresas e ORDER BY e.orden, e.id`);
      return json(res, 200, { empresas: r.rows });
    }
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const nombre = String(b.nombre || '').trim().toUpperCase();
    if (!nombre) return json(res, 400, { error: 'Falta el nombre de la empresa.' });
    const v = [nombre, (b.rut || '').trim() || null, (b.codigo || '').trim() || null, (b.area || '').trim() || null, parseInt(b.orden, 10) || 0, b.activo !== false];
    if (b.id) await pool.query('UPDATE empresas SET nombre=$2, rut=$3, codigo=$4, area=$5, orden=$6, activo=$7 WHERE id=$1', [parseInt(b.id, 10), ...v]);
    else await pool.query('INSERT INTO empresas (nombre, rut, codigo, area, orden, activo) VALUES ($1,$2,$3,$4,$5,$6)', v);
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
