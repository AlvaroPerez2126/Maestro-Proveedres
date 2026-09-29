import { db, autorizar, json } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';

// PDF de una factura del cruce, identificada por RUT + Folio + Tipo doc.
// GET    /api/pdf?rut=..&folio=..&tipo=..   -> descarga el PDF
// POST   /api/pdf?rut=..&folio=..&tipo=..   (cuerpo = el PDF, header x-nombre) -> sube o reemplaza
// DELETE /api/pdf?rut=..&folio=..&tipo=..   -> elimina (quien lo subió o un administrador)
export const config = { api: { bodyParser: false } };
const MAX = 4 * 1024 * 1024; // 4 MB (límite de Vercel por solicitud: 4,5 MB)
const CRUCE = ['cruce', 'atrasos', 'rapido'];

async function leerCuerpo(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const partes = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX + 1024) throw Object.assign(new Error('El PDF supera 4 MB.'), { status: 413 }); partes.push(c); }
  return Buffer.concat(partes);
}

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
      const r = await pool.query('SELECT nombre, datos FROM cruce_pdfs WHERE rut=$1 AND folio=$2 AND tipo_doc=$3', clave);
      if (!r.rowCount) return json(res, 404, { error: 'No hay PDF para este documento.' });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.rows[0].nombre || `factura_${folio}.pdf`)}"`);
      return res.end(r.rows[0].datos);
    }

    if (req.method === 'POST') {
      const datos = await leerCuerpo(req);
      if (!datos.length) return json(res, 400, { error: 'El archivo está vacío.' });
      if (datos.length > MAX) return json(res, 413, { error: 'El PDF supera 4 MB. Redúcelo o escanéalo con menor resolución.' });
      if (datos.subarray(0, 5).toString('latin1') !== '%PDF-') return json(res, 400, { error: 'El archivo no es un PDF válido.' });
      let nombre = ''; try { nombre = decodeURIComponent(req.headers['x-nombre'] || ''); } catch (e) {}
      nombre = (nombre || `factura_${folio}.pdf`).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
      await pool.query(
        `INSERT INTO cruce_pdfs (rut, folio, tipo_doc, nombre, tam, datos, subido_por, subido) VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (rut, folio, tipo_doc) DO UPDATE SET nombre=EXCLUDED.nombre, tam=EXCLUDED.tam, datos=EXCLUDED.datos, subido_por=EXCLUDED.subido_por, subido=now()`,
        [...clave, nombre, datos.length, datos, a.usuario]);
      return json(res, 200, { ok: true, nombre, tam: datos.length, por: a.usuario });
    }

    if (req.method === 'DELETE') {
      const r = await pool.query('SELECT subido_por FROM cruce_pdfs WHERE rut=$1 AND folio=$2 AND tipo_doc=$3', clave);
      if (!r.rowCount) return json(res, 200, { ok: true });
      if (!a.admin && r.rows[0].subido_por !== a.usuario) return json(res, 403, { error: `Solo ${r.rows[0].subido_por} o un administrador pueden eliminar este PDF.` });
      await pool.query('DELETE FROM cruce_pdfs WHERE rut=$1 AND folio=$2 AND tipo_doc=$3', clave);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Método no permitido' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
