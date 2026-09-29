import { db, autorizar, json } from '../lib/db.js';
import { asegurarEsquema, TABLAS } from '../lib/schema.js';

// POST /api/cargar  { tabla, reemplazar, filas: [ {col: valor} ] }   ó   { fin: true, detalle: {...} }
export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Usa POST' });
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req, { admin: true });
    if (!a.ok) return json(res, 401, { error: a.msg });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (body.fin) {
      await pool.query(`INSERT INTO cargas (detalle) VALUES ($1)`, [JSON.stringify(body.detalle || {})]);
      return json(res, 200, { ok: true });
    }
    const { tabla, reemplazar, filas } = body;
    if (!TABLAS[tabla]) return json(res, 400, { error: 'Tabla desconocida: ' + tabla });
    if (!Array.isArray(filas)) return json(res, 400, { error: 'Faltan filas' });

    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      if (reemplazar) await cli.query(`TRUNCATE ${tabla}`);
      if (filas.length) {
        await cli.query(
          `INSERT INTO ${tabla} SELECT * FROM json_populate_recordset(NULL::${tabla}, $1::json)`,
          [JSON.stringify(filas)]
        );
      }
      await cli.query('COMMIT');
    } catch (e) {
      await cli.query('ROLLBACK');
      throw e;
    } finally {
      cli.release();
    }
    return json(res, 200, { ok: true, insertadas: filas.length });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
