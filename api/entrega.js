import { db, autorizar, json, empresaActiva } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';

// Facturas pendientes por entregar (el producto aún no llega).
// POST /api/entrega?rut&folio&tipo  {accion:'marcar', obs, fecha_estimada}  -> la marca (o edita la nota)
//                                   {accion:'llego'}                        -> el producto llegó (queda en el historial)
//                                   {accion:'reabrir'}                      -> vuelve a "pendiente"
//                                   {accion:'quitar'}                       -> borra la marca (quien marcó o un administrador)
const CRUCE = ['cruce', 'atrasos', 'rapido', 'porentregar'];

export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req);
    if (!a.ok) return json(res, 401, { error: a.msg });
    if (!a.admin && !a.paginas.some(p => CRUCE.includes(p))) return json(res, 403, { error: 'No tienes acceso al cruce de facturas.' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido' });
    const u = new URL(req.url, 'http://x');
    const rut = (u.searchParams.get('rut') || '').trim();
    const folio = parseInt(u.searchParams.get('folio') || '', 10);
    const tipo = parseInt(u.searchParams.get('tipo') || '0', 10) || 0;
    if (!rut || !Number.isFinite(folio)) return json(res, 400, { error: 'Falta RUT o folio.' });
    const emp = await empresaActiva(req, a);
    const k = [emp, rut, folio, tipo];
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const actual = (await pool.query('SELECT * FROM cruce_entregas WHERE empresa=$1 AND rut=$2 AND folio=$3 AND tipo_doc=$4', k)).rows[0];

    if (b.accion === 'marcar') {
      const obs = String(b.obs || '').trim().slice(0, 300) || null;
      const fe = /^\d{4}-\d{2}-\d{2}$/.test(b.fecha_estimada || '') ? b.fecha_estimada : null;
      await pool.query(`INSERT INTO cruce_entregas (empresa, rut, folio, tipo_doc, estado, obs, fecha_estimada, marcado_por, marcado)
        VALUES ($1,$2,$3,$4,'pendiente',$5,$6,$7, now())
        ON CONFLICT (empresa, rut, folio, tipo_doc) DO UPDATE SET obs = $5, fecha_estimada = $6`, [...k, obs, fe, a.usuario]);
    } else if (b.accion === 'llego' || b.accion === 'reabrir') {
      if (!actual) return json(res, 404, { error: 'Esta factura no está marcada como pendiente por entregar.' });
      if (b.accion === 'llego') await pool.query(`UPDATE cruce_entregas SET estado='entregado', entregado_por=$5, entregado=now() WHERE empresa=$1 AND rut=$2 AND folio=$3 AND tipo_doc=$4`, [...k, a.usuario]);
      else await pool.query(`UPDATE cruce_entregas SET estado='pendiente', entregado_por=NULL, entregado=NULL WHERE empresa=$1 AND rut=$2 AND folio=$3 AND tipo_doc=$4`, k);
    } else if (b.accion === 'quitar') {
      if (!actual) return json(res, 200, { ok: true });
      if (!a.admin && actual.marcado_por !== a.usuario) return json(res, 403, { error: `Solo ${actual.marcado_por} o un administrador pueden quitar la marca.` });
      await pool.query('DELETE FROM cruce_entregas WHERE empresa=$1 AND rut=$2 AND folio=$3 AND tipo_doc=$4', k);
      return json(res, 200, { ok: true, entrega: null });
    } else return json(res, 400, { error: 'Acción desconocida' });

    const r = (await pool.query('SELECT * FROM cruce_entregas WHERE empresa=$1 AND rut=$2 AND folio=$3 AND tipo_doc=$4', k)).rows[0];
    return json(res, 200, { ok: true, entrega: r });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
