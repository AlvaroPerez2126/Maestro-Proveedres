import { db, autorizar, json, empresaActiva } from '../lib/db.js';
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
    const emp = await empresaActiva(req, a);   // los Excel se cargan en la empresa seleccionada

    if (body.fin) {
      await pool.query(`INSERT INTO cargas (detalle, empresa) VALUES ($1, $2)`, [JSON.stringify(body.detalle || {}), emp]);
      return json(res, 200, { ok: true });
    }
    const { tabla, reemplazar, filas, mes } = body;
    if (!TABLAS[tabla]) return json(res, 400, { error: 'Tabla desconocida: ' + tabla });
    if (!Array.isArray(filas)) return json(res, 400, { error: 'Faltan filas' });

    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      // Cruce SII / INET: solo se reemplaza el mismo mes (los otros meses se conservan)
      if (reemplazar && mes && ['cruce_sii', 'cruce_inet'].includes(tabla))
        await cli.query(`DELETE FROM ${tabla} WHERE empresa = $1 AND (mes = $2 OR mes IS NULL)`, [emp, mes]);
      else if (reemplazar) await cli.query(`DELETE FROM ${tabla} WHERE empresa = $1`, [emp]);
      if (filas.length) {
        filas.forEach(f => { f.empresa = emp; if (mes) f.mes = mes; });
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
    return json(res, e.status || 500, { error: e.message });
  }
}
