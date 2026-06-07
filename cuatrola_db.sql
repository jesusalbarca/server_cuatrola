-- ============================================================
-- CUATROLA - Script completo de base de datos
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- Limpiar tablas si existen
DROP TABLE IF EXISTS user_stats CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ============================================================
-- TABLA: users
-- ============================================================
CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        UNIQUE NOT NULL,
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  active_skin   TEXT        DEFAULT 'default',
  created_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE users DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- TABLA: user_stats
-- ============================================================
CREATE TABLE user_stats (
  user_id      UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  games_played INT         DEFAULT 0,
  games_won    INT         DEFAULT 0,
  hands_won    INT         DEFAULT 0,
  total_points INT         DEFAULT 0,
  mesas_limpias INT        DEFAULT 0,
  cantes       INT         DEFAULT 0,
  last_played  TIMESTAMPTZ DEFAULT NULL
);

ALTER TABLE user_stats DISABLE ROW LEVEL SECURITY;

-- ============================================================
-- Función: al insertar un usuario, crea su fila de stats
-- ============================================================
CREATE OR REPLACE FUNCTION create_user_stats()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_stats (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_user_created
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION create_user_stats();

-- ============================================================
-- Usuarios por defecto
-- ============================================================

-- Contraseña '111111' hasheada con bcrypt
-- Contraseña 'admin123' hasheada con bcrypt

-- El trigger crea la fila en user_stats automáticamente al insertar en users.
-- Usamos UPDATE para poner las stats iniciales.

INSERT INTO users (username, email, password_hash) VALUES
  ('a',     'a@a.a',             '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'),
  ('b',     'b@b.b',             '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'),
  ('c',     'c@c.c',             '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'),
  ('d',     'd@d.d',             '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi'),
  ('admin', 'admin@cuatrola.com','$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');

UPDATE users SET active_skin = 'dark' WHERE username = 'admin';

UPDATE user_stats SET games_played = 30, games_won = 30
WHERE user_id IN (SELECT id FROM users WHERE username IN ('a','b','c','d','admin'));
