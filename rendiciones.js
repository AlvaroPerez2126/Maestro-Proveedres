import { db, autorizar, json, empresaActiva, empresasPermitidas } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';

// Caja chica / Fondos por rendir
// GET  /api/rendiciones              -> lista (admin: todas; resto: las propias)
// GET  /api/rendiciones?id=5         -> detalle con líneas y respaldos (sin el archivo)
// POST /api/rendiciones {accion:'guardar', rendicion:{...}, lineas:[{id?,descripcion,...}]}  -> crea/actualiza
// POST /api/rendiciones {accion:'estado', id, estado:'abierta'|'cerrada'}
// POST /api/rendiciones {accion:'eliminar', id}
// POST /api/rendiciones {accion:'firmar', id, rol}  |  {accion:'quitar_firma', id, rol}
// GET  /api/rendiciones?firma=ID&rol=confeccionado  -> PNG de la firma puesta
export const ROLES = ['confeccionado', 'revisado', 'aprobado'];
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const f = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null;
const t = (v, max = 200) => v == null ? null : String(v).trim().slice(0, max) || null;

export async function permiso(pool, a, id) {
  const r = await pool.query('SELECT creado_por, estado, empresa FROM rendiciones WHERE id=$1', [id]);
  if (!r.rowCount) return { ok: false, status: 404, msg: 'La rendición no existe.' };
  if (!a.admin && r.rows[0].creado_por !== a.usuario) return { ok: false, status: 403, msg: 'Esta rendición es de otro usuario.' };
  if (!(await empresasPermitidas(a)).some(e => e.id === r.rows[0].empresa)) return { ok: false, status: 403, msg: 'No tienes acceso a la empresa de esta rendición.' };
  return { ok: true, estado: r.rows[0].estado };
}

async function detalle(pool, id) {
  const c = await pool.query(`SELECT r.*, e.nombre AS empresa_nombre, e.rut AS empresa_rut FROM rendiciones r LEFT JOIN empresas e ON e.id = r.empresa WHERE r.id=$1`, [id]);
  const l = await pool.query('SELECT * FROM rendicion_lineas WHERE rendicion_id=$1 ORDER BY orden, id', [id]);
  const r = await pool.query(`SELECT r.id, r.linea_id, r.nombre, r.tipo, r.tam, r.subido_por, r.subido FROM rendicion_respaldos r
                              JOIN rendicion_lineas l ON l.id = r.linea_id WHERE l.rendicion_id=$1 ORDER BY r.id`, [id]);
  const fi = await pool.query('SELECT rol, usuario, nombre, firmado FROM rendicion_firmas WHERE rendicion_id=$1', [id]);
  return { rendicion: c.rows[0], lineas: l.rows.map(x => ({ ...x, respaldos: r.rows.filter(y => y.linea_id === x.id) })), firmas: fi.rows };
}

export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req);
    if (!a.ok) return json(res, 401, { error: a.msg });
    if (!a.admin && !a.paginas.includes('rendiciones')) return json(res, 403, { error: 'No tienes acceso a Caja chica / Rendiciones.' });
    const u = new URL(req.url, 'http://x');
    const emp = await empresaActiva(req, a);

    if (req.method === 'GET' && u.searchParams.get('firma')) {
      const id = parseInt(u.searchParams.get('firma'), 10);
      const p = await permiso(pool, a, id); if (!p.ok) return json(res, p.status, { error: p.msg });
      const r = await pool.query('SELECT imagen FROM rendicion_firmas WHERE rendicion_id=$1 AND rol=$2', [id, u.searchParams.get('rol')]);
      if (!r.rowCount) return json(res, 404, { error: 'Sin firma' });
      res.statusCode = 200; res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store');
      return res.end(r.rows[0].imagen);
    }
    if (req.method === 'GET') {
      const id = parseInt(u.searchParams.get('id') || '', 10);
      if (id) { const p = await permiso(pool, a, id); if (!p.ok) return json(res, p.status, { error: p.msg }); return json(res, 200, await detalle(pool, id)); }
      const r = await pool.query(`
        SELECT c.id, c.numero, c.fecha, c.nombre, c.rut, c.monto_asignado, c.codigo, c.area, c.estado, c.creado_por, c.actualizado,
               COALESCE(SUM(COALESCE(l.cantidad,1) * COALESCE(l.subtotal,0)), 0) AS total, COUNT(l.id)::int AS lineas,
               (SELECT COUNT(*)::int FROM rendicion_respaldos r JOIN rendicion_lineas l2 ON l2.id = r.linea_id WHERE l2.rendicion_id = c.id) AS respaldos,
               COUNT(l.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM rendicion_respaldos r WHERE r.linea_id = l.id))::int AS sin_respaldo
        FROM rendiciones c LEFT JOIN rendicion_lineas l ON l.rendicion_id = c.id
        WHERE c.empresa = $3 AND ($1 OR c.creado_por = $2) GROUP BY c.id ORDER BY c.numero DESC NULLS LAST, c.id DESC`, [!!a.admin, a.usuario, emp]);
      return json(res, 200, { rendiciones: r.rows });
    }

    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (b.accion === 'guardar') {
      const c = b.rendicion || {};
      let id = parseInt(c.id, 10) || null;
      if (id) { const p = await permiso(pool, a, id); if (!p.ok) return json(res, p.status, { error: p.msg }); if (p.estado === 'cerrada') return json(res, 400, { error: 'La rendición está cerrada. Reábrela para modificarla.' }); }
      const cli = await pool.connect();
      try {
        await cli.query('BEGIN');
        // códigos fijos del formato: los de la empresa (ej. 9001 / CM)
        const ec = (await cli.query('SELECT codigo, area FROM empresas WHERE id=$1', [emp])).rows[0] || {};
        const vals = [c.numero ? parseInt(c.numero, 10) : null, f(c.fecha), t(c.nombre), t(c.rut, 20), n(c.monto_asignado), ec.codigo || null, ec.area || null, t(c.girar_a), t(c.girar_rut, 20)];
        if (id) {
          await cli.query(`UPDATE rendiciones SET numero=$2, fecha=$3, nombre=$4, rut=$5, monto_asignado=$6, girar_a=$9, girar_rut=$10, actualizado=now(), codigo=COALESCE(codigo,$7), area=COALESCE(area,$8) WHERE id=$1`, [id, ...vals]);
        } else {
          if (!vals[0]) vals[0] = (await cli.query('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM rendiciones WHERE empresa=$1', [emp])).rows[0].n;
          id = (await cli.query(`INSERT INTO rendiciones (numero, fecha, nombre, rut, monto_asignado, codigo, area, girar_a, girar_rut, creado_por, empresa)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [...vals, a.usuario, emp])).rows[0].id;
        }
        const guardadas = [];
        for (const [i, l] of (Array.isArray(b.lineas) ? b.lineas : []).entries()) {
          const lv = [i + 1, t(l.descripcion, 300), t(l.tipo_dcto, 40), f(l.fecha), n(l.cantidad ?? 1), n(l.subtotal)];
          const lid = parseInt(l.id, 10);
          if (lid) { await cli.query(`UPDATE rendicion_lineas SET orden=$3, descripcion=$4, tipo_dcto=$5, fecha=$6, cantidad=$7, subtotal=$8 WHERE id=$1 AND rendicion_id=$2`, [lid, id, ...lv]); guardadas.push(lid); }
          else guardadas.push((await cli.query(`INSERT INTO rendicion_lineas (rendicion_id, orden, descripcion, tipo_dcto, fecha, cantidad, subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [id, ...lv])).rows[0].id);
        }
        // líneas quitadas (y sus respaldos)
        await cli.query('DELETE FROM rendicion_lineas WHERE rendicion_id=$1 AND NOT (id = ANY($2::int[]))', [id, guardadas]);
        await cli.query('COMMIT');
      } catch (e) { await cli.query('ROLLBACK'); throw e; } finally { cli.release(); }
      return json(res, 200, await detalle(pool, id));
    }
    const id = parseInt(b.id, 10);
    const p = await permiso(pool, a, id); if (!p.ok) return json(res, p.status, { error: p.msg });
    if (b.accion === 'estado') {
      const e = b.estado === 'cerrada' ? 'cerrada' : 'abierta';
      await pool.query('UPDATE rendiciones SET estado=$2, actualizado=now() WHERE id=$1', [id, e]);
      return json(res, 200, await detalle(pool, id));
    }
    if (b.accion === 'firmar' || b.accion === 'quitar_firma') {
      if (!ROLES.includes(b.rol)) return json(res, 400, { error: 'Firma inválida.' });
      if (b.accion === 'firmar') {
        const f = await pool.query('SELECT imagen FROM firmas WHERE usuario=$1', [a.usuario]);
        if (!f.rowCount) return json(res, 400, { error: 'Primero carga tu firma en "Mi firma".' });
        await pool.query(`INSERT INTO rendicion_firmas (rendicion_id, rol, usuario, nombre, imagen) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (rendicion_id, rol) DO UPDATE SET usuario=EXCLUDED.usuario, nombre=EXCLUDED.nombre, imagen=EXCLUDED.imagen, firmado=now()`,
          [id, b.rol, a.usuario, a.nombre, f.rows[0].imagen]);
      } else {
        const f = await pool.query('SELECT usuario FROM rendicion_firmas WHERE rendicion_id=$1 AND rol=$2', [id, b.rol]);
        if (f.rowCount && !a.admin && f.rows[0].usuario !== a.usuario) return json(res, 403, { error: 'Solo quien firmó o un administrador puede quitar esta firma.' });
        await pool.query('DELETE FROM rendicion_firmas WHERE rendicion_id=$1 AND rol=$2', [id, b.rol]);
      }
      return json(res, 200, await detalle(pool, id));
    }
    if (b.accion === 'eliminar') {
      if (p.estado === 'cerrada' && !a.admin) return json(res, 400, { error: 'La rendición está cerrada; solo un administrador puede eliminarla.' });
      await pool.query('DELETE FROM rendiciones WHERE id=$1', [id]);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: 'Acción desconocida' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
