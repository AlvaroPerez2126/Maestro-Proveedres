import { PDFDocument } from 'pdf-lib';
import { db, autorizar, json } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';
import { estampar } from '../lib/timbre.js';

// Documentos PDF de una factura del cruce (RUT + Folio + Tipo doc).
//   clase = factura | oc      -> documento subido por el encargado
//   clase = union             -> FACTURA + OC unidos en un solo PDF (se genera al pedirlo)
//   La factura se entrega con su TIMBRE de recepción (si tiene); &original=1 la entrega sin timbre.
// GET    /api/pdf?rut&folio&tipo&clase   -> descarga
// POST   /api/pdf?rut&folio&tipo&clase   (cuerpo = PDF, header x-nombre) -> sube o reemplaza
// DELETE /api/pdf?rut&folio&tipo&clase   -> elimina (quien lo subió o un administrador)
export const config = { api: { bodyParser: false } };
const MAX = 4 * 1024 * 1024; // 4 MB (Vercel acepta hasta 4,5 MB por solicitud)
const CRUCE = ['cruce', 'atrasos', 'rapido'];
const NOMBRE = { factura: 'factura', oc: 'orden de compra' };

async function leerCuerpo(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const partes = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX + 1024) throw Object.assign(new Error('El PDF supera 4 MB.'), { status: 413 }); partes.push(c); }
  return Buffer.concat(partes);
}

function enviarPdf(res, datos, nombre) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(nombre)}`);
  res.setHeader('x-nombre', encodeURIComponent(nombre));
  return res.end(datos);
}

async function conTimbre(pool, clave, datos) {
  const t = await pool.query('SELECT pagina, x, y, ancho, campos FROM cruce_timbres WHERE rut=$1 AND folio=$2 AND tipo_doc=$3', clave);
  if (!t.rowCount) return datos;
  try { return await estampar(datos, t.rows[0]); } catch (e) { return datos; }
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
    const clase = (u.searchParams.get('clase') || 'factura').toLowerCase();
    if (!rut || !Number.isFinite(folio)) return json(res, 400, { error: 'Falta RUT o folio.' });
    if (!['factura', 'oc', 'union'].includes(clase)) return json(res, 400, { error: 'Tipo de documento inválido.' });
    const clave = [rut, folio, tipo];

    if (req.method === 'GET' && clase === 'union') {
      const r = await pool.query(`SELECT clase, datos FROM cruce_pdfs WHERE rut=$1 AND folio=$2 AND tipo_doc=$3 AND clase IN ('factura','oc')`, clave);
      const f = r.rows.find(x => x.clase === 'factura'), o = r.rows.find(x => x.clase === 'oc');
      if (!f || !o) return json(res, 404, { error: `Falta ${!f ? 'la factura' : 'la orden de compra'} para generar la unión.` });
      const union = await PDFDocument.create();
      const facturaTimbrada = await conTimbre(pool, clave, f.datos);
      for (const [datos, nom] of [[facturaTimbrada, 'la factura'], [o.datos, 'la orden de compra']]) {
        let src;
        try { src = await PDFDocument.load(datos, { ignoreEncryption: true }); }
        catch (e) { return json(res, 422, { error: `No se pudo leer el PDF de ${nom} (puede estar protegido o dañado). Vuelve a subirlo.` }); }
        (await union.copyPages(src, src.getPageIndices())).forEach(p => union.addPage(p));
      }
      union.setTitle(`Factura ${folio} + OC`);
      return enviarPdf(res, Buffer.from(await union.save()), `FACTURA_OC_${folio}.pdf`);
    }

    if (clase === 'union') return json(res, 400, { error: 'La unión se genera sola; sube la factura y la OC por separado.' });
    const k = [...clave, clase];

    if (req.method === 'GET') {
      const r = await pool.query('SELECT nombre, datos FROM cruce_pdfs WHERE rut=$1 AND folio=$2 AND tipo_doc=$3 AND clase=$4', k);
      if (!r.rowCount) return json(res, 404, { error: `No hay ${NOMBRE[clase]} para este documento.` });
      const datos = clase === 'factura' && u.searchParams.get('original') !== '1' ? await conTimbre(pool, clave, r.rows[0].datos) : r.rows[0].datos;
      return enviarPdf(res, datos, r.rows[0].nombre || `${clase}_${folio}.pdf`);
    }

    if (req.method === 'POST') {
      const datos = await leerCuerpo(req);
      if (!datos.length) return json(res, 400, { error: 'El archivo está vacío.' });
      if (datos.length > MAX) return json(res, 413, { error: 'El PDF supera 4 MB. Redúcelo o escanéalo con menor resolución.' });
      if (datos.subarray(0, 1024).toString('latin1').indexOf('%PDF-') < 0) return json(res, 400, { error: 'El archivo no es un PDF válido.' });
      let nombre = ''; try { nombre = decodeURIComponent(req.headers['x-nombre'] || ''); } catch (e) {}
      nombre = (nombre || `${clase}_${folio}.pdf`).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
      await pool.query(
        `INSERT INTO cruce_pdfs (rut, folio, tipo_doc, clase, nombre, tam, datos, subido_por, subido) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (rut, folio, tipo_doc, clase) DO UPDATE SET nombre=EXCLUDED.nombre, tam=EXCLUDED.tam, datos=EXCLUDED.datos, subido_por=EXCLUDED.subido_por, subido=now()`,
        [...k, nombre, datos.length, datos, a.usuario]);
      return json(res, 200, { ok: true, nombre, tam: datos.length, por: a.usuario });
    }

    if (req.method === 'DELETE') {
      const r = await pool.query('SELECT subido_por FROM cruce_pdfs WHERE rut=$1 AND folio=$2 AND tipo_doc=$3 AND clase=$4', k);
      if (!r.rowCount) return json(res, 200, { ok: true });
      if (!a.admin && r.rows[0].subido_por !== a.usuario) return json(res, 403, { error: `Solo ${r.rows[0].subido_por} o un administrador pueden eliminar este documento.` });
      await pool.query('DELETE FROM cruce_pdfs WHERE rut=$1 AND folio=$2 AND tipo_doc=$3 AND clase=$4', k);
      if (clase === 'factura') await pool.query('DELETE FROM cruce_timbres WHERE rut=$1 AND folio=$2 AND tipo_doc=$3', clave);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Método no permitido' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
}
