import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Diseño del timbre "RECEPCION" (unidades internas: 300 x 180; se escala al ancho elegido)
export const W = 300, H = 180;
export const FILAS = [
  { y: 50,  campos: [{ k: 'fecha', l: 'Fecha:' }] },
  { y: 70,  campos: [{ k: 'bodega', l: 'Código Bodega:' }] },
  { y: 90,  campos: [{ k: 'responsable', l: 'Responsable:' }] },
  { y: 110, campos: [{ k: 'vb', l: 'V° B°:' }] },
  { y: 130, campos: [{ k: 'digitado', l: 'Digitado COMPUAGRO:', hasta: 196 }, { k: 'fecha_dig', l: 'Fecha:', desde: 200 }] },
  { y: 150, campos: [{ k: 'obs', l: 'Observaciones:' }] },
  { y: 170, campos: [{ k: 'obs2', l: '' }] },
];
const GRIS = rgb(0.29, 0.29, 0.29), AZUL = rgb(0.13, 0.2, 0.62);
// Las fuentes estándar de PDF solo admiten Latin-1: se limpian caracteres raros
const limpio = s => String(s ?? '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '');

export async function estampar(pdfBytes, t) {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const paginas = doc.getPages();
  const page = paginas[Math.min(Math.max(0, t.pagina || 0), paginas.length - 1)];
  const { width: pw, height: ph } = page.getSize();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const k = (t.ancho || 0.42) * pw / W;             // escala unidades -> puntos PDF
  const X0 = (t.x || 0) * pw, Y0 = ph - (t.y || 0) * ph;
  const P = (u, v) => ({ x: X0 + u * k, y: Y0 - v * k });
  const c = t.campos || {};

  // fondo levemente blanco para que se lea sobre el documento + marco
  const esq = P(2, H - 2);
  page.drawRectangle({ x: esq.x, y: esq.y, width: (W - 4) * k, height: (H - 4) * k, color: rgb(1, 1, 1), opacity: 0.55, borderColor: GRIS, borderWidth: 1.6 * k, borderOpacity: 0.95 });
  // título espaciado
  const tit = 'RECEPCION', ts = 16 * k, esp = 5 * k;
  const anchoTit = [...tit].reduce((s, ch) => s + bold.widthOfTextAtSize(ch, ts), 0) + esp * (tit.length - 1);
  let tx = X0 + (W * k - anchoTit) / 2; const ty = P(0, 26).y;
  for (const ch of tit) { page.drawText(ch, { x: tx, y: ty, size: ts, font: bold, color: GRIS }); tx += bold.widthOfTextAtSize(ch, ts) + esp; }

  const fs = 10.5 * k, fv = 11 * k;
  for (const fila of FILAS) {
    for (const cp of fila.campos) {
      const ini = cp.desde ?? 10, fin = cp.hasta ?? 290;
      const base = P(ini, fila.y);
      let xv = base.x;
      if (cp.l) { page.drawText(cp.l, { x: base.x, y: base.y, size: fs, font: helv, color: GRIS }); xv += helv.widthOfTextAtSize(cp.l, fs) + 3 * k; }
      const finX = P(fin, 0).x;
      page.drawLine({ start: { x: xv, y: base.y - 1.5 * k }, end: { x: finX, y: base.y - 1.5 * k }, thickness: 0.9 * k, color: GRIS, dashArray: [0.9 * k, 2.2 * k] });
      const val = limpio(c[cp.k]).trim();
      if (val) {
        let size = fv; const disp = finX - xv - 2 * k;
        while (size > 5 * k && helv.widthOfTextAtSize(val, size) > disp) size -= 0.5 * k;
        page.drawText(val, { x: xv + 2 * k, y: base.y + 0.5 * k, size, font: helv, color: AZUL });
      }
    }
  }
  return Buffer.from(await doc.save());
}
