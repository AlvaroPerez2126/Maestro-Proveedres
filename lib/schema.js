// Estructura de la base de datos en Neon (se crea sola la primera vez)
export const TABLAS = {
  compras: `analisis text, razon_social text, n_docto text, fecha_docto date, fecha_vencto date,
            n_compte bigint, tipo_compte text, fecha_compte date, glosa text,
            cargos numeric, abonos numeric, sem int`,
  cuenta_2107101: `analisis text, razon_social text, n_docto text, fecha_docto date, fecha_vencto date,
            n_compte bigint, tipo_compte text, fecha_compte date, glosa text,
            cargos numeric, abonos numeric`,
  listado_prov: `analisis text, razon_social text, tipo text`,
  doc_escaneados: `marca_temporal timestamp, tipo_documento text, inet text, foto text, orden_compra text`,
  pagos: `inet bigint, tipo_documento int, num_documento bigint, fecha_emision date, fecha_vencimiento date,
          fecha_pago date, rut text, nombre_proveedor text, columna1 text, monto numeric,
          banco int, tipo_cta int, n_cta bigint, tipo_prov text`,
  facturas_proyectos: `com bigint, concepto text`,
  prov: `rut text, proveedor text, tipo_prov text`,
  maestro_proveedores: `rut_inet text, rut text, razon_social text, nombre_fantasia text, categoria text,
          banco int, forma_pago int, cuenta_corriente bigint, comentario text, direccion text,
          comuna text, pais text, correo text, telefono text, atendido_por text, cargo text, web text`,
  bancos: `codigo int, nombre text`,
};

// Vistas: aquí se replican las relaciones del modelo de Power BI
export const VISTAS = {
  // Documento escaneado (PDF) por N° de ingreso INET (uno por número)
  v_doc: `SELECT DISTINCT ON (inet) inet, foto, tipo_documento
          FROM doc_escaneados WHERE inet IS NOT NULL AND inet <> ''
          ORDER BY inet, marca_temporal DESC NULLS LAST`,

  // COMPRAS  ->  DOC ESCANEADOS (# Compte = NUMERO INGRESO INET)
  v_compras: `SELECT c.n_compte, c.analisis, c.razon_social, c.n_docto, c.fecha_docto, c.fecha_vencto,
                c.fecha_compte, c.glosa, c.tipo_compte, c.sem,
                SUM(COALESCE(c.abonos,0) - COALESCE(c.cargos,0)) AS monto,
                SUM(COALESCE(c.abonos,0)) AS abonos,
                MAX(d.foto) AS foto,
                MAX(lp.tipo) AS tipo
              FROM compras c
              LEFT JOIN v_doc d ON d.inet = c.n_compte::text
              LEFT JOIN (SELECT DISTINCT ON (analisis) analisis, tipo FROM listado_prov) lp ON lp.analisis = c.analisis
              GROUP BY c.n_compte, c.analisis, c.razon_social, c.n_docto, c.fecha_docto, c.fecha_vencto,
                       c.fecha_compte, c.glosa, c.tipo_compte, c.sem`,

  // CUENTA 2107101 (documentos por pagar) -> LISTADO PROV, COMPRAS (semana), DOC ESCANEADOS
  v_saldo: `SELECT s.tipo_compte, s.n_compte, s.analisis, s.razon_social, s.n_docto,
                s.fecha_docto, s.fecha_vencto, s.glosa,
                SUM(COALESCE(s.abonos,0) - COALESCE(s.cargos,0)) AS saldo,
                MAX(lp.tipo) AS tipo, MAX(cs.sem) AS sem, MAX(d.foto) AS foto
              FROM cuenta_2107101 s
              LEFT JOIN (SELECT DISTINCT ON (analisis) analisis, tipo FROM listado_prov) lp ON lp.analisis = s.analisis
              LEFT JOIN (SELECT DISTINCT ON (n_compte) n_compte, sem FROM compras) cs ON cs.n_compte = s.n_compte
              LEFT JOIN v_doc d ON d.inet = s.n_compte::text
              GROUP BY s.tipo_compte, s.n_compte, s.analisis, s.razon_social, s.n_docto,
                       s.fecha_docto, s.fecha_vencto, s.glosa`,

  // PAGOS -> DOC ESCANEADOS, FACTURAS PROYECTOS, BANCOS
  v_pagos: `SELECT p.inet, p.rut, p.nombre_proveedor, p.fecha_pago, p.fecha_emision, p.fecha_vencimiento,
                p.num_documento, p.tipo_documento, p.monto,
                p.banco AS semana,  -- en el Excel la columna BANCO guarda la SEMANA de pago
                p.n_cta, p.tipo_prov,
                fp.concepto, d.foto
              FROM pagos p
              LEFT JOIN v_doc d ON d.inet = p.inet::text
              LEFT JOIN (SELECT DISTINCT ON (com) com, concepto FROM facturas_proyectos) fp ON fp.com = p.inet`,

  v_maestro: `SELECT rut, razon_social, nombre_fantasia, categoria, comentario, direccion, comuna,
                correo, telefono, atendido_por, cargo, web
              FROM maestro_proveedores WHERE razon_social IS NOT NULL`,
};

export const CONSULTAS = {
  compras: 'SELECT * FROM v_compras ORDER BY n_compte',
  saldo: 'SELECT * FROM v_saldo ORDER BY fecha_vencto, n_compte',
  pagos: 'SELECT * FROM v_pagos ORDER BY fecha_pago DESC NULLS LAST, inet',
  maestro: 'SELECT * FROM v_maestro ORDER BY razon_social',
};

let listo = false;
export async function asegurarEsquema(pool) {
  if (listo) return;
  const sql = [];
  for (const [t, cols] of Object.entries(TABLAS)) sql.push(`CREATE TABLE IF NOT EXISTS ${t} (${cols});`);
  sql.push(`CREATE TABLE IF NOT EXISTS usuarios (usuario text PRIMARY KEY, nombre text, clave_hash text NOT NULL, paginas text[] DEFAULT '{}', admin boolean DEFAULT false, activo boolean DEFAULT true, creado timestamptz DEFAULT now());`);
  sql.push(`CREATE TABLE IF NOT EXISTS cargas (id serial PRIMARY KEY, fecha timestamptz DEFAULT now(), detalle jsonb);`);
  sql.push(`CREATE INDEX IF NOT EXISTS ix_doc_inet ON doc_escaneados(inet);`);
  sql.push(`CREATE INDEX IF NOT EXISTS ix_compras_compte ON compras(n_compte);`);
  sql.push(`DROP VIEW IF EXISTS ${Object.keys(VISTAS).reverse().join(', ')} CASCADE;`);
  for (const [v, q] of Object.entries(VISTAS)) sql.push(`CREATE VIEW ${v} AS ${q};`);
  await pool.query(sql.join('\n'));
  listo = true;
}
