import { db, autorizar, json } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';

// Timbre de RECEPCION de una factura del cruce.
// GET    /api/timbre?rut&folio&tipo  -> { timbre }  (o null)
// POST   /api/timbre?rut&folio&tipo  { pagina, x, y, ancho, campos } -> crea o sobrescribe
// DELETE /api/timbre?rut&folio&tipo  -> quita el timbre (quien timbró o un administrador)
const CRUCE = ['cruce', 'atrasos', 'rapido'];
const CAMPOS = ['fecha', 'bodega', 'responsable', 'vb', 'digitado', 'fecha_dig', 'obs', 'obs2'];
const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req);
    if (!a.ok) return json(res, 401, { error: a.msg });
    if (!a.admin && !a.paginas.some(p => CRUCE.includes(p))) return json(res, 403, { error: 'No tienes acceso al cruce de facturas.' });
    const u = new URL(req.url, 'http://x');
    const rut = (u.searchParams.get('rut') || '').trim();
    const folio = parseInt(u.searchParams.get('folio') || '', 10);
    const tipo = parseInt(u.searchParams.get('tipo') || '0', 10) || 0;
    if (!rut || !Number.isFinite(folio)) return json(res, 400, { error: 'Falta RUT o folio.' });
    const clave = [rut, folio, tipo];

    if (req.method === 'GET') {
      const r = await pool.query('SELECT pagina, x, y, ancho, campos, timbrado_por, timbrado FROM cruce_timbres WHERE rut=$1 AND folio=$2 AND tipo_doc=$3', clave);
      return json(res, 200, { timbre: r.rows[0] || null });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const f = await pool.query(`SELECT 1 FROM cruce_pdfs WHERE rut=$1 AND folio=$2 AND tipo_doc=$3 AND clase='factura'`, clave);
      if (!f.rowCount) return json(res, 400, { error: 'Primero sube el PDF de la factura.' });
      const campos = {};
      for (const c of CAMPOS) campos[c] = String((b.campos || {})[c] ?? '').slice(0, 120);
      const v = [num(b.pagina, 0, 500, 0), num(b.x, 0, 1, 0.5), num(b.y, 0, 1, 0.05), num(b.ancho, 0.15, 0.9, 0.42)];
      await pool.query(
        `INSERT INTO cruce_timbres (rut, folio, tipo_doc, pagina, x, y, ancho, campos, timbrado_por, timbrado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (rut, folio, tipo_doc) DO UPDATE SET pagina=EXCLUDED.pagina, x=EXCLUDED.x, y=EXCLUDED.y, ancho=EXCLUDED.ancho, campos=EXCLUDED.campos, timbrado_por=EXCLUDED.timbrado_por, timbrado=now()`,
        [...clave, ...v, JSON.stringify(campos), a.usuario]);
      return json(res, 200, { ok: true, por: a.usuario });
    }
    if (req.method === 'DELETE') {
      const r = await pool.query('SELECT timbrado_por FROM cruce_timbres WHERE rut=$1 AND folio=$2 AND tipo_doc=$3', clave);
      if (!r.rowCount) return json(res, 200, { ok: true });
      if (!a.admin && r.rows[0].timbrado_por !== a.usuario) return json(res, 403, { error: `Solo ${r.rows[0].timbrado_por} o un administrador pueden quitar este timbre.` });
      await pool.query('DELETE FROM cruce_timbres WHERE rut=$1 AND folio=$2 AND tipo_doc=$3', clave);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Método no permitido' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
