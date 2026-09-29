import crypto from 'crypto';
import pg from 'pg';

// Devolver fechas como texto 'YYYY-MM-DD' y números como number
pg.types.setTypeParser(1082, v => v);                 // date
pg.types.setTypeParser(1114, v => v);                 // timestamp
pg.types.setTypeParser(1184, v => v);                 // timestamptz
pg.types.setTypeParser(1700, v => v === null ? null : parseFloat(v)); // numeric
pg.types.setTypeParser(20, v => v === null ? null : parseInt(v, 10)); // bigint

let pool;
export function db() {
  if (!pool) {
    const cs = process.env.DATABASE_URL;
    if (!cs) throw new Error('Falta la variable DATABASE_URL (cadena de conexión de Neon).');
    const local = /localhost|127\.0\.0\.1/.test(cs);
    // Neon entrega la URL con ?sslmode=require&channel_binding=require; el SSL se configura aquí
    const u = new URL(cs.replace(/^postgres(ql)?:/, 'http:'));
    u.searchParams.delete('sslmode'); u.searchParams.delete('channel_binding');
    pool = new pg.Pool({
      connectionString: u.toString().replace(/^http:/, 'postgresql:'),
      ssl: local ? false : true,
      max: 3,
    });
  }
  return pool;
}

// ---------- Usuarios y permisos ----------
// Páginas de la web y la vista de datos que necesita cada una
export const PAGINAS = {
  facturas: 'compras', pagos: 'pagos', porpagar: 'saldo', contratistas: 'saldo',
  proyectos: 'pagos', semana: 'pagos', pac: 'compras', proyectados: 'saldo', maestro: 'maestro',
  cruce: 'cruce', atrasos: 'cruce', rapido: 'cruce',
};

export function hashClave(clave) {
  const sal = crypto.randomBytes(16).toString('hex');
  return sal + ':' + crypto.scryptSync(clave, sal, 32).toString('hex');
}
function verificar(clave, guardado) {
  if (!guardado || !guardado.includes(':')) return false;
  const [sal, h] = guardado.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(clave, sal, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const dec = v => { try { return decodeURIComponent(v || ''); } catch (e) { return v || ''; } };
const cache = new Map(); // evita recalcular el hash en cada consulta (2 min)

// Devuelve { ok, usuario, nombre, admin, paginas[] } o { ok:false, msg }
export async function autorizar(req, { admin = false } = {}) {
  const usuario = dec(req.headers['x-usuario']).trim().toLowerCase();
  const clave = dec(req.headers['x-clave']);
  if (!clave) return { ok: false, msg: 'Ingresa tu usuario y clave.' };
  const todas = Object.keys(PAGINAS);
  let r = null;
  // Administrador principal: la clave ADMIN_PASSWORD de Vercel (usuario "admin" o vacío)
  const adm = process.env.ADMIN_PASSWORD;
  if (adm && clave === adm && (!usuario || usuario === 'admin')) r = { ok: true, usuario: 'admin', nombre: 'Administrador', admin: true, paginas: todas };
  if (!r && usuario) {
    const k = usuario + '\u0001' + crypto.createHash('sha256').update(clave).digest('hex');
    const c = cache.get(k);
    if (c && c.t > Date.now()) r = c.r;
    else {
      const q = await db().query('SELECT usuario, nombre, clave_hash, paginas, admin, activo FROM usuarios WHERE usuario = $1', [usuario]);
      const u = q.rows[0];
      if (u && u.activo && verificar(clave, u.clave_hash)) {
        r = { ok: true, usuario: u.usuario, nombre: u.nombre || u.usuario, admin: u.admin, paginas: u.admin ? todas : (u.paginas || []).filter(p => PAGINAS[p]) };
        cache.set(k, { r, t: Date.now() + 2 * 60e3 });
      }
    }
  }
  if (!r) return { ok: false, msg: 'Usuario o clave incorrectos.' };
  if (admin && !r.admin) return { ok: false, msg: 'Solo un administrador puede hacer esto.' };
  return r;
}
export const limpiarCache = () => cache.clear();

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
