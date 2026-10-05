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
  // ----- Cruce de facturas (SII vs libro de compras INET) -----
  cruce_sii: `tipo_doc int, rut text, razon_social text, folio bigint, fecha_docto date,
          monto_exento numeric, monto_neto numeric, monto_iva numeric, monto_iva_no_rec numeric, monto_total numeric, mes text`,
  cruce_inet: `n_compte bigint, rut text, razon_social text, folio bigint, fecha_docto date, total numeric, mes text`,
  cruce_prov: `rut text, proveedor text, encargado text, pago15 text, credito int`,
  cruce_docs: `id text, pdf text`,
  cruce_tipos: `doc int, tipo text`,
  cruce_param: `clave text, valor text`,
  // ----- MO externa: Control tarjeta contratista (Agrosmart) y asistencia (reloj / app) -----
  mo_tarjeta: `n_faena bigint, prestador text, fecha date, predio text, cuartel text, faena text, especie text, variedad text,
          trabajador text, nivel_transversal text, forma_pago text, un_pago text, cantidad numeric, valor_trato numeric,
          valor_jornada numeric, n_jornada numeric, bono numeric, asignado numeric, pendiente numeric, total_cuartel numeric,
          nivel2 text, cuartel_principal text, obs_faena text`,
  mo_asistencia: `id text, trabajador text, contratista text, fecha date, hora text`,
  // ----- Asistencia contratista: se sincroniza desde la planilla Google Sheets (marcas por trabajador y día) -----
  asis_contr: `trabajador text, rut text, contratista text, fecha date, marcas int`,
};

// Vistas: aquí se replican las relaciones del modelo de Power BI
export const VISTAS = {
  // Documento escaneado (PDF) por N° de ingreso INET (uno por número)
  v_doc: `SELECT DISTINCT ON (empresa, inet) empresa, inet, foto, tipo_documento
          FROM doc_escaneados WHERE inet IS NOT NULL AND inet <> ''
          ORDER BY empresa, inet, marca_temporal DESC NULLS LAST`,

  // COMPRAS  ->  DOC ESCANEADOS (# Compte = NUMERO INGRESO INET)
  v_compras: `SELECT c.empresa, c.n_compte, c.analisis, c.razon_social, c.n_docto, c.fecha_docto, c.fecha_vencto,
                c.fecha_compte, c.glosa, c.tipo_compte, c.sem,
                SUM(COALESCE(c.abonos,0) - COALESCE(c.cargos,0)) AS monto,
                SUM(COALESCE(c.abonos,0)) AS abonos,
                MAX(d.foto) AS foto,
                MAX(lp.tipo) AS tipo
              FROM compras c
              LEFT JOIN v_doc d ON d.empresa = c.empresa AND d.inet = c.n_compte::text
              LEFT JOIN (SELECT DISTINCT ON (empresa, analisis) empresa, analisis, tipo FROM listado_prov) lp ON lp.empresa = c.empresa AND lp.analisis = c.analisis
              GROUP BY c.empresa, c.n_compte, c.analisis, c.razon_social, c.n_docto, c.fecha_docto, c.fecha_vencto,
                       c.fecha_compte, c.glosa, c.tipo_compte, c.sem`,

  // CUENTA 2107101 (documentos por pagar) -> LISTADO PROV, COMPRAS (semana), DOC ESCANEADOS
  v_saldo: `SELECT s.empresa, s.tipo_compte, s.n_compte, s.analisis, s.razon_social, s.n_docto,
                s.fecha_docto, s.fecha_vencto, s.glosa,
                SUM(COALESCE(s.abonos,0) - COALESCE(s.cargos,0)) AS saldo,
                MAX(lp.tipo) AS tipo, MAX(cs.sem) AS sem, MAX(d.foto) AS foto
              FROM cuenta_2107101 s
              LEFT JOIN (SELECT DISTINCT ON (empresa, analisis) empresa, analisis, tipo FROM listado_prov) lp ON lp.empresa = s.empresa AND lp.analisis = s.analisis
              LEFT JOIN (SELECT DISTINCT ON (empresa, n_compte) empresa, n_compte, sem FROM compras) cs ON cs.empresa = s.empresa AND cs.n_compte = s.n_compte
              LEFT JOIN v_doc d ON d.empresa = s.empresa AND d.inet = s.n_compte::text
              GROUP BY s.empresa, s.tipo_compte, s.n_compte, s.analisis, s.razon_social, s.n_docto,
                       s.fecha_docto, s.fecha_vencto, s.glosa`,

  // PAGOS -> DOC ESCANEADOS, FACTURAS PROYECTOS, BANCOS
  v_pagos: `SELECT p.empresa, p.inet, p.rut, p.nombre_proveedor, p.fecha_pago, p.fecha_emision, p.fecha_vencimiento,
                p.num_documento, p.tipo_documento, p.monto,
                p.banco AS semana,  -- en el Excel la columna BANCO guarda la SEMANA de pago
                p.n_cta, p.tipo_prov,
                fp.concepto, d.foto
              FROM pagos p
              LEFT JOIN v_doc d ON d.empresa = p.empresa AND d.inet = p.inet::text
              LEFT JOIN (SELECT DISTINCT ON (empresa, com) empresa, com, concepto FROM facturas_proyectos) fp ON fp.empresa = p.empresa AND fp.com = p.inet`,

  // CRUCE: cada documento del registro de compras del SII se busca en el libro de compras INET
  // por Folio + Monto total (igual que la columna "Validacion" del Excel). Si no está -> Pendiente.
  v_cruce: `SELECT s.empresa, s.mes, s.rut, s.razon_social, COALESCE(t.tipo, s.tipo_doc::text) AS doc, s.tipo_doc, s.folio, s.fecha_docto,
                s.monto_exento, s.monto_neto, s.monto_iva, s.monto_total,
                (s.fecha_docto - (now() AT TIME ZONE 'America/Santiago')::date) AS dias_atraso,
                COALESCE(NULLIF(trim(p.encargado), ''), 'SIN ENCARGADO') AS encargado, p.credito, p.pago15,
                CASE WHEN EXISTS (SELECT 1 FROM cruce_inet i WHERE i.empresa = s.empresa AND i.folio = s.folio AND i.total = s.monto_total)
                     THEN 'Ingresado' ELSE 'Pendiente' END AS estado,
                d.pdf, (SELECT valor FROM cruce_param cp WHERE cp.empresa = s.empresa AND clave = 'mes_cruce' LIMIT 1) AS mes_cruce,
                pf.nombre AS pdf_nombre, pf.subido_por AS pdf_por, pf.subido AS pdf_fecha,
                po.l->0->>'n' AS oc_nombre, po.l->0->>'p' AS oc_por, po.l->0->>'f' AS oc_fecha, COALESCE(po.n, 0) AS oc_n, po.l AS oc_lista,
                tb.timbrado_por AS timbre_por, tb.timbrado AS timbre_fecha
              FROM cruce_sii s
              LEFT JOIN cruce_timbres tb ON tb.empresa = s.empresa AND tb.rut = s.rut AND tb.folio = s.folio AND tb.tipo_doc = COALESCE(s.tipo_doc, 0)
              LEFT JOIN cruce_pdfs pf ON pf.empresa = s.empresa AND pf.rut = s.rut AND pf.folio = s.folio AND pf.tipo_doc = COALESCE(s.tipo_doc, 0) AND pf.clase = 'factura'
              LEFT JOIN LATERAL (SELECT count(*)::int AS n,   -- una o varias OC por documento (clase oc, oc2, oc3…)
                  json_agg(json_build_object('c', clase, 'n', nombre, 'p', subido_por, 'f', subido) ORDER BY length(clase), clase) AS l
                FROM cruce_pdfs x WHERE x.empresa = s.empresa AND x.rut = s.rut AND x.folio = s.folio AND x.tipo_doc = COALESCE(s.tipo_doc, 0) AND x.clase ~ '^oc[0-9]*$') po ON po.n > 0
              LEFT JOIN (SELECT DISTINCT ON (empresa, rut) empresa, rut, encargado, credito, pago15 FROM cruce_prov WHERE rut IS NOT NULL) p ON p.empresa = s.empresa AND p.rut = s.rut
              LEFT JOIN (SELECT DISTINCT ON (empresa, doc) empresa, doc, tipo FROM cruce_tipos) t ON t.empresa = s.empresa AND t.doc = s.tipo_doc
              LEFT JOIN (SELECT DISTINCT ON (empresa, id) empresa, id, pdf FROM cruce_docs) d ON d.empresa = s.empresa AND d.id = s.folio::text || round(s.monto_total)::text
              WHERE s.folio IS NOT NULL`,

  // Asistencia por contratista y día (equivale a COUNTIFS de la hoja VAL)
  v_mo_asis: `SELECT empresa, upper(trim(contratista)) AS contratista, fecha, count(*)::int AS asistencia
              FROM mo_asistencia WHERE fecha IS NOT NULL GROUP BY 1, 2, 3`,

  v_maestro: `SELECT empresa, rut, razon_social, nombre_fantasia, categoria, comentario, direccion, comuna,
                correo, telefono, atendido_por, cargo, web
              FROM maestro_proveedores WHERE razon_social IS NOT NULL`,
};

export const CONSULTAS = {
  compras: 'SELECT * FROM v_compras WHERE empresa = $1 ORDER BY n_compte',
  saldo: 'SELECT * FROM v_saldo WHERE empresa = $1 ORDER BY fecha_vencto, n_compte',
  pagos: 'SELECT * FROM v_pagos WHERE empresa = $1 ORDER BY fecha_pago DESC NULLS LAST, inet',
  maestro: 'SELECT * FROM v_maestro WHERE empresa = $1 ORDER BY razon_social',
  cruce: 'SELECT * FROM v_cruce WHERE empresa = $1 ORDER BY fecha_docto, folio',
  mo: `SELECT n_faena, upper(trim(prestador)) AS contratista, fecha, predio, cuartel, faena, forma_pago, cantidad, n_jornada,
         bono, total_cuartel, obs_faena FROM mo_tarjeta WHERE empresa = $1 AND fecha IS NOT NULL ORDER BY fecha, prestador, n_faena`,
  moasis: 'SELECT * FROM v_mo_asis WHERE empresa = $1 ORDER BY fecha, contratista',
  asiscontr: `SELECT upper(trim(trabajador)) AS trabajador, max(rut) AS rut, upper(trim(contratista)) AS contratista, fecha, sum(marcas)::int AS marcas
              FROM asis_contr WHERE empresa = $1 AND fecha IS NOT NULL GROUP BY 1, 3, 4 ORDER BY fecha, 1`,
};

let listo = false;
export async function asegurarEsquema(pool) {
  if (listo) return;
  const sql = [];
  // ----- Empresas del holding (cada una con sus propios datos y documentos) -----
  sql.push(`CREATE TABLE IF NOT EXISTS empresas (id serial PRIMARY KEY, nombre text NOT NULL, rut text, codigo text, area text, orden int DEFAULT 0, activo boolean DEFAULT true);`);
  sql.push(`INSERT INTO empresas (id, nombre, rut, codigo, area, orden)
            SELECT 1, 'SOCIEDAD AGRICOLA SANTA ANA DEL ROSARIO LTDA', '76.016.396-1', '9001', 'CM', 1 WHERE NOT EXISTS (SELECT 1 FROM empresas);`);
  sql.push(`SELECT setval(pg_get_serial_sequence('empresas','id'), GREATEST((SELECT MAX(id) FROM empresas), 1));`);
  sql.push(`INSERT INTO empresas (nombre, orden) SELECT 'AGRICOLA MONFRUT', 2 WHERE (SELECT count(*) FROM empresas) = 1 AND NOT EXISTS (SELECT 1 FROM empresas WHERE nombre ILIKE '%MONFRUT%');`);
  for (const [t, cols] of Object.entries(TABLAS)) sql.push(`CREATE TABLE IF NOT EXISTS ${t} (${cols}, empresa int NOT NULL DEFAULT 1);`);
  sql.push(`CREATE TABLE IF NOT EXISTS usuarios (usuario text PRIMARY KEY, nombre text, clave_hash text NOT NULL, paginas text[] DEFAULT '{}', admin boolean DEFAULT false, activo boolean DEFAULT true, creado timestamptz DEFAULT now());`);
  sql.push(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresas int[];`);  // NULL = todas las empresas
  // PDFs de facturas subidos desde la web (no se borran al actualizar los Excel)
  sql.push(`CREATE TABLE IF NOT EXISTS cruce_pdfs (rut text NOT NULL, folio bigint NOT NULL, tipo_doc int NOT NULL DEFAULT 0, clase text NOT NULL DEFAULT 'factura', nombre text, tam int, datos bytea NOT NULL, subido_por text, subido timestamptz DEFAULT now(), PRIMARY KEY (rut, folio, tipo_doc, clase));`);
  // Migración: versiones anteriores no tenían la columna "clase" (factura / oc)
  sql.push(`ALTER TABLE cruce_pdfs ADD COLUMN IF NOT EXISTS clase text NOT NULL DEFAULT 'factura';`);
  sql.push(`DO $$ BEGIN
    IF (SELECT count(*) FROM information_schema.key_column_usage WHERE table_name = 'cruce_pdfs' AND constraint_name = 'cruce_pdfs_pkey') = 3 THEN
      ALTER TABLE cruce_pdfs DROP CONSTRAINT cruce_pdfs_pkey;
      ALTER TABLE cruce_pdfs ADD PRIMARY KEY (rut, folio, tipo_doc, clase);
    END IF; END $$;`);
  // Timbre de RECEPCION sobre la factura (se guarda aparte: el PDF original no se modifica)
  sql.push(`CREATE TABLE IF NOT EXISTS cruce_timbres (rut text NOT NULL, folio bigint NOT NULL, tipo_doc int NOT NULL DEFAULT 0, pagina int DEFAULT 0, x real, y real, ancho real, campos jsonb, timbrado_por text, timbrado timestamptz DEFAULT now(), PRIMARY KEY (rut, folio, tipo_doc));`);
  // ----- Caja chica / Fondos por rendir -----
  sql.push(`CREATE TABLE IF NOT EXISTS rendiciones (id serial PRIMARY KEY, numero int, fecha date, nombre text, rut text,
    monto_asignado numeric DEFAULT 0, codigo text, area text, girar_a text, girar_rut text, estado text DEFAULT 'abierta',
    creado_por text, creado timestamptz DEFAULT now(), actualizado timestamptz DEFAULT now());`);
  sql.push(`CREATE TABLE IF NOT EXISTS rendicion_lineas (id serial PRIMARY KEY, rendicion_id int NOT NULL REFERENCES rendiciones(id) ON DELETE CASCADE,
    orden int, descripcion text, tipo_dcto text, fecha date, cantidad numeric DEFAULT 1, subtotal numeric DEFAULT 0);`);
  sql.push(`CREATE TABLE IF NOT EXISTS rendicion_respaldos (id serial PRIMARY KEY, linea_id int NOT NULL REFERENCES rendicion_lineas(id) ON DELETE CASCADE,
    nombre text, tipo text, tam int, datos bytea NOT NULL, subido_por text, subido timestamptz DEFAULT now());`);
  sql.push(`CREATE INDEX IF NOT EXISTS ix_rl_rend ON rendicion_lineas(rendicion_id);`);
  sql.push(`CREATE INDEX IF NOT EXISTS ix_rr_lin ON rendicion_respaldos(linea_id);`);
  // Firmas: una por usuario (PNG transparente) y las firmas puestas en cada rendición (copia al momento de firmar)
  sql.push(`CREATE TABLE IF NOT EXISTS firmas (usuario text PRIMARY KEY, imagen bytea NOT NULL, actualizado timestamptz DEFAULT now());`);
  sql.push(`CREATE TABLE IF NOT EXISTS rendicion_firmas (rendicion_id int NOT NULL REFERENCES rendiciones(id) ON DELETE CASCADE, rol text NOT NULL,
    usuario text, nombre text, imagen bytea NOT NULL, firmado timestamptz DEFAULT now(), PRIMARY KEY (rendicion_id, rol));`);
  // Planillas externas (Google Sheets) que se sincronizan solas
  sql.push(`CREATE TABLE IF NOT EXISTS fuentes (empresa int NOT NULL, clave text NOT NULL, url text, hoja text, ultima timestamptz, filas int, error text, actualizado_por text, PRIMARY KEY (empresa, clave));`);
  sql.push(`CREATE TABLE IF NOT EXISTS cargas (id serial PRIMARY KEY, fecha timestamptz DEFAULT now(), detalle jsonb);`);
  // Migración multiempresa: los datos existentes quedan en la empresa 1
  for (const t of [...Object.keys(TABLAS), 'cruce_pdfs', 'cruce_timbres', 'rendiciones', 'cargas'])
    sql.push(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS empresa int NOT NULL DEFAULT 1;`);
  // Mes del cruce (periodo AAAA-MM): cada mes se guarda aparte y los pendientes de meses anteriores se mantienen
  sql.push(`ALTER TABLE cruce_sii ADD COLUMN IF NOT EXISTS mes text;`);
  sql.push(`ALTER TABLE cruce_inet ADD COLUMN IF NOT EXISTS mes text;`);
  for (const [t, pk] of [['cruce_pdfs', 'empresa, rut, folio, tipo_doc, clase'], ['cruce_timbres', 'empresa, rut, folio, tipo_doc']])
    sql.push(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.key_column_usage WHERE table_name = '${t}' AND constraint_name = '${t}_pkey' AND column_name = 'empresa') THEN
        ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${t}_pkey;
        ALTER TABLE ${t} ADD PRIMARY KEY (${pk});
      END IF; END $$;`);
  for (const t of ['compras', 'cuenta_2107101', 'doc_escaneados', 'pagos', 'cruce_sii', 'cruce_inet', 'rendiciones', 'asis_contr'])
    sql.push(`CREATE INDEX IF NOT EXISTS ix_${t}_emp ON ${t}(empresa);`);
  sql.push(`CREATE INDEX IF NOT EXISTS ix_doc_inet ON doc_escaneados(inet);`);
  sql.push(`CREATE INDEX IF NOT EXISTS ix_compras_compte ON compras(n_compte);`);
  sql.push(`DROP VIEW IF EXISTS ${Object.keys(VISTAS).reverse().join(', ')} CASCADE;`);
  for (const [v, q] of Object.entries(VISTAS)) sql.push(`CREATE VIEW ${v} AS ${q};`);
  await pool.query(sql.join('\n'));
  listo = true;
}
