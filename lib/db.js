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

export function autorizado(req, admin = false) {
  const clave = req.headers['x-clave'] || '';
  const app = process.env.APP_PASSWORD;
  const adm = process.env.ADMIN_PASSWORD || app;
  if (!app) return { ok: false, msg: 'Falta configurar APP_PASSWORD en Vercel.' };
  if (admin ? clave === adm : (clave === app || clave === adm)) return { ok: true, admin: clave === adm };
  return { ok: false, msg: 'Clave incorrecta.' };
}

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
