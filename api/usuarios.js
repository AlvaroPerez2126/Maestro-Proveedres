import { db, autorizar, json, hashClave, limpiarCache, PAGINAS } from '../lib/db.js';
import { asegurarEsquema } from '../lib/schema.js';

// Administración de usuarios (solo administradores)
// GET  /api/usuarios                         -> lista
// POST /api/usuarios {accion:'guardar', usuario, nombre, clave?, paginas[], admin, activo}
// POST /api/usuarios {accion:'eliminar', usuario}
export default async function handler(req, res) {
  try {
    const pool = db();
    await asegurarEsquema(pool);
    const a = await autorizar(req, { admin: true });
    if (!a.ok) return json(res, 401, { error: a.msg });

    if (req.method === 'GET') {
      const r = await pool.query('SELECT usuario, nombre, paginas, admin, activo, creado FROM usuarios ORDER BY usuario');
      return json(res, 200, { usuarios: r.rows });
    }
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const usuario = String(b.usuario || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(usuario)) return json(res, 400, { error: 'Usuario inválido: usa letras, números, punto o guion (sin espacios ni tildes).' });
    if (usuario === 'admin') return json(res, 400, { error: '"admin" está reservado para la clave principal.' });

    if (b.accion === 'eliminar') {
      await pool.query('DELETE FROM usuarios WHERE usuario = $1', [usuario]);
      limpiarCache();
      return json(res, 200, { ok: true });
    }
    if (b.accion === 'guardar') {
      const paginas = (Array.isArray(b.paginas) ? b.paginas : []).filter(p => PAGINAS[p]);
      const existe = (await pool.query('SELECT 1 FROM usuarios WHERE usuario = $1', [usuario])).rowCount > 0;
      const clave = String(b.clave || '');
      if (!existe && clave.length < 6) return json(res, 400, { error: 'La clave debe tener al menos 6 caracteres.' });
      if (clave && clave.length < 6) return json(res, 400, { error: 'La clave debe tener al menos 6 caracteres.' });
      if (existe) {
        await pool.query(
          `UPDATE usuarios SET nombre = $2, paginas = $3, admin = $4, activo = $5 ${clave ? ', clave_hash = $6' : ''} WHERE usuario = $1`,
          clave ? [usuario, b.nombre || null, paginas, !!b.admin, b.activo !== false, hashClave(clave)]
                : [usuario, b.nombre || null, paginas, !!b.admin, b.activo !== false]);
      } else {
        await pool.query('INSERT INTO usuarios (usuario, nombre, clave_hash, paginas, admin, activo) VALUES ($1,$2,$3,$4,$5,$6)',
          [usuario, b.nombre || null, hashClave(clave), paginas, !!b.admin, b.activo !== false]);
      }
      limpiarCache();
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: 'Acción desconocida' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
