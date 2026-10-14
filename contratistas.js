import { db, autorizar, json, empresaActiva } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';

// Proceso Contratistas: precalificación documental (formulario MF-RG-PR-38).
// GET  ?accion=lista                      -> contratistas de la empresa con el estado de sus 13 documentos
// GET  ?accion=ficha&id                   -> datos, documentos e historial
// GET  ?accion=archivo&id&k               -> descarga el documento adjunto
// POST ?accion=guardar     {id?, ...datos} -> crea o edita
// POST ?accion=eliminar | duplicar | rechazar {id}
// POST ?accion=revisar     {id, k, estado, obs}
// POST ?accion=obs         {id, obs}
// POST ?accion=nota        {id, texto}     -> agrega una línea al historial (ej. "Preparó correo…")
// POST ?accion=adjuntar&id&k  (cuerpo = archivo, header x-nombre) -> adjunta o reemplaza (máx. 4 MB)
export const config = { api: { bodyParser: false } };
const MAX = 4 * 1024 * 1024;
const DOCS = ['SA', 'SB', 'SC', 'SD', 'SE', 'SF', 'PA', 'PB', 'PC', 'PD', 'PE', 'PF', 'PG'];
const ESTADOS = ['PENDIENTE', 'CUMPLE', 'NO CUMPLE', 'NO APLICA'];
const CAMPOS = ['nombre', 'razon', 'rut', 'rep', 'rut_rep', 'contrato', 'email', 'tel', 'fecha', 'obs'];
const EXT = /\.(pdf|docx?|xlsx?|jpe?g|png)$/i;
const TIPO = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const err = (status, msg) => Object.assign(new Error(msg), { status });

async function leer(req, max) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body && typeof req.body === 'object') return Buffer.from(JSON.stringify(req.body));
  if (typeof req.body === 'string') return Buffer.from(req.body);
  const partes = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw err(413, 'El archivo supera 4 MB.'); partes.push(c); }
  return Buffer.concat(partes);
}

export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req);
    if (!a.ok) return json(res, 401, { error: a.msg });
    if (!a.admin && !a.paginas.includes('pcontratistas')) return json(res, 403, { error: 'No tienes acceso a Proceso Contratistas.' });
    const emp = await empresaActiva(req, a);
    const u = new URL(req.url, 'http://x');
    const accion = u.searchParams.get('accion') || 'lista';
    const quien = a.nombre || a.usuario;
    const hist = (id, texto, cli = pool) => cli.query('INSERT INTO pc_historial (contratista_id, usuario, accion) VALUES ($1,$2,$3)', [id, quien, texto]);
    // El contratista debe ser de la empresa activa
    const propio = async id => {
      const r = await pool.query('SELECT * FROM pc_contratistas WHERE id = $1 AND empresa = $2', [parseInt(id, 10) || 0, emp]);
      if (!r.rowCount) throw err(404, 'Contratista no encontrado en esta empresa.');
      return r.rows[0];
    };
    const docsDe = async ids => (await pool.query(`SELECT contratista_id, k, estado, obs, revisado, revisor, archivo_nombre, archivo_tam, cargado, cargado_por
      FROM pc_docs WHERE contratista_id = ANY($1::int[]) ORDER BY k`, [ids])).rows;

    if (req.method === 'GET') {
      if (accion === 'lista') {
        const cs = (await pool.query('SELECT * FROM pc_contratistas WHERE empresa = $1 ORDER BY nombre', [emp])).rows;
        const ds = await docsDe(cs.map(c => c.id));
        cs.forEach(c => c.docs = ds.filter(d => d.contratista_id === c.id));
        return json(res, 200, { contratistas: cs });
      }
      if (accion === 'ficha') {
        const c = await propio(u.searchParams.get('id'));
        c.docs = await docsDe([c.id]);
        c.historial = (await pool.query('SELECT fecha, usuario, accion FROM pc_historial WHERE contratista_id = $1 ORDER BY id DESC LIMIT 500', [c.id])).rows;
        return json(res, 200, { contratista: c });
      }
      if (accion === 'archivo') {
        const c = await propio(u.searchParams.get('id'));
        const r = await pool.query('SELECT archivo_nombre, archivo_tipo, archivo FROM pc_docs WHERE contratista_id = $1 AND k = $2 AND archivo IS NOT NULL', [c.id, u.searchParams.get('k')]);
        if (!r.rowCount) return json(res, 404, { error: 'El documento no tiene archivo adjunto.' });
        const f = r.rows[0];
        res.statusCode = 200;
        res.setHeader('Content-Type', f.archivo_tipo || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `${u.searchParams.get('descargar') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.archivo_nombre || 'documento')}`);
        res.setHeader('x-nombre', encodeURIComponent(f.archivo_nombre || 'documento'));
        return res.end(f.archivo);
      }
      return json(res, 400, { error: 'Acción desconocida' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido' });

    if (accion === 'adjuntar') {
      const c = await propio(u.searchParams.get('id'));
      const k = u.searchParams.get('k');
      if (!DOCS.includes(k)) return json(res, 400, { error: 'Documento inválido.' });
      let nombre = ''; try { nombre = decodeURIComponent(req.headers['x-nombre'] || ''); } catch (e) {}
      nombre = nombre.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 150);
      if (!EXT.test(nombre)) return json(res, 400, { error: 'Formato no permitido (PDF, DOC, DOCX, XLS, XLSX, JPG, PNG).' });
      const datos = await leer(req, MAX + 1024);
      if (!datos.length) return json(res, 400, { error: 'El archivo está vacío.' });
      if (datos.length > MAX) return json(res, 413, { error: 'El archivo supera 4 MB.' });
      const ext = nombre.split('.').pop().toLowerCase();
      const previo = (await pool.query('SELECT archivo_nombre FROM pc_docs WHERE contratista_id = $1 AND k = $2 AND archivo IS NOT NULL', [c.id, k])).rowCount > 0;
      await pool.query(`INSERT INTO pc_docs (contratista_id, k, estado, archivo_nombre, archivo_tam, archivo_tipo, archivo, cargado, cargado_por, revisado, revisor)
        VALUES ($1,$2,'PENDIENTE',$3,$4,$5,$6, now(), $7, NULL, NULL)
        ON CONFLICT (contratista_id, k) DO UPDATE SET estado='PENDIENTE', archivo_nombre=$3, archivo_tam=$4, archivo_tipo=$5, archivo=$6, cargado=now(), cargado_por=$7, revisado=NULL, revisor=NULL`,
        [c.id, k, nombre, datos.length, TIPO[ext] || 'application/octet-stream', datos, quien]);
      await hist(c.id, `${previo ? 'Reemplazó' : 'Adjuntó'} documento ${k[1]} (${k[0] === 'S' ? 'SUBCONTRATACIÓN' : 'PREVENCIÓN DE RIESGOS'}): ${nombre}`);
      return json(res, 200, { ok: true });
    }

    let b = {};
    const crudo = await leer(req, 256 * 1024);
    if (crudo.length) { try { b = JSON.parse(crudo.toString('utf8')); } catch (e) { return json(res, 400, { error: 'Datos inválidos.' }); } }

    if (accion === 'guardar') {
      const v = {}; for (const f of CAMPOS) v[f] = b[f] == null ? null : String(b[f]).trim().slice(0, f === 'obs' ? 2000 : 200) || null;
      if (v.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(v.fecha)) v.fecha = null;
      if (!v.nombre || !v.rut || !v.contrato) return json(res, 400, { error: 'Nombre, RUT y número de contrato son obligatorios.' });
      if (b.id) {
        const c = await propio(b.id);
        await pool.query(`UPDATE pc_contratistas SET ${CAMPOS.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1`, [c.id, ...CAMPOS.map(f => v[f])]);
        await hist(c.id, 'Editó datos del contratista');
        return json(res, 200, { ok: true, id: c.id });
      }
      const r = await pool.query(`INSERT INTO pc_contratistas (empresa, creado_por, ${CAMPOS.join(', ')}) VALUES ($1, $2, ${CAMPOS.map((_, i) => '$' + (i + 3)).join(', ')}) RETURNING id`,
        [emp, quien, ...CAMPOS.map(f => v[f])]);
      await hist(r.rows[0].id, 'Contratista creado');
      return json(res, 200, { ok: true, id: r.rows[0].id });
    }
    const c = await propio(b.id);
    if (accion === 'eliminar') {
      await pool.query('DELETE FROM pc_contratistas WHERE id = $1', [c.id]);
      return json(res, 200, { ok: true });
    }
    if (accion === 'duplicar') {
      const r = await pool.query(`INSERT INTO pc_contratistas (empresa, creado_por, ${CAMPOS.join(', ')})
        SELECT empresa, $2, nombre || ' (copia)', razon, rut, rep, rut_rep, contrato, email, tel, current_date, obs FROM pc_contratistas WHERE id = $1 RETURNING id`, [c.id, quien]);
      await hist(r.rows[0].id, `Duplicado desde ${c.nombre} (documentos reiniciados)`);
      return json(res, 200, { ok: true, id: r.rows[0].id });
    }
    if (accion === 'rechazar') {
      await pool.query('UPDATE pc_contratistas SET rech = NOT rech WHERE id = $1', [c.id]);
      await hist(c.id, c.rech ? 'Precalificación reabierta' : 'Precalificación RECHAZADA');
      return json(res, 200, { ok: true, rech: !c.rech });
    }
    if (accion === 'obs') {
      await pool.query('UPDATE pc_contratistas SET obs = $2 WHERE id = $1', [c.id, String(b.obs || '').slice(0, 2000) || null]);
      await hist(c.id, 'Actualizó observaciones generales');
      return json(res, 200, { ok: true });
    }
    if (accion === 'nota') {
      await hist(c.id, String(b.texto || '').slice(0, 300));
      return json(res, 200, { ok: true });
    }
    if (accion === 'revisar') {
      const k = b.k, estado = b.estado, obs = String(b.obs || '').trim().slice(0, 1000);
      if (!DOCS.includes(k) || !ESTADOS.includes(estado)) return json(res, 400, { error: 'Datos inválidos.' });
      const d = (await pool.query('SELECT archivo IS NOT NULL AS tiene FROM pc_docs WHERE contratista_id = $1 AND k = $2', [c.id, k])).rows[0];
      if (estado === 'NO CUMPLE' && !obs) return json(res, 400, { error: 'Debe ingresar una observación para marcar NO CUMPLE.' });
      if (estado === 'CUMPLE' && !(d && d.tiene)) return json(res, 400, { error: 'Adjunte el documento antes de marcarlo como CUMPLE.' });
      const pend = estado === 'PENDIENTE';
      await pool.query(`INSERT INTO pc_docs (contratista_id, k, estado, obs, revisado, revisor) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (contratista_id, k) DO UPDATE SET estado=$3, obs=$4, revisado=$5, revisor=$6`,
        [c.id, k, estado, obs || null, pend ? null : new Date(), pend ? null : quien]);
      await hist(c.id, `Documento ${k[1]} (${k[0] === 'S' ? 'SUBCONTRATACIÓN' : 'PREVENCIÓN DE RIESGOS'}): ${estado}${obs ? ' — ' + obs : ''}`);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: 'Acción desconocida' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
