import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'cuatrola-secret-key-change-in-production';
const SALT_ROUNDS = 10;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    realtime: { transport: WebSocket }
});

function generateToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

function mapUser(u, s = {}) {
    return {
        id: u.id,
        username: u.username,
        email: u.email,
        createdAt: u.created_at,
        activeSkin: u.active_skin,
        stats: {
            gamesPlayed:  s.games_played  ?? 0,
            gamesWon:     s.games_won     ?? 0,
            handsWon:     s.hands_won     ?? 0,
            totalPoints:  s.total_points  ?? 0,
            mesasLimpias: s.mesas_limpias ?? 0,
            cantes:       s.cantes        ?? 0,
            lastPlayed:   s.last_played   ?? null
        }
    };
}

export async function register(username, email, password) {
    const { data: existing } = await supabase
        .from('users')
        .select('id')
        .or(`username.eq.${username},email.eq.${email}`)
        .limit(1);

    if (existing && existing.length > 0) {
        return { success: false, error: 'Usuario o email ya existe' };
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const { data: user, error } = await supabase
        .from('users')
        .insert({ username, email, password_hash })
        .select()
        .single();

    if (error) return { success: false, error: 'Error guardando usuario' };

    const token = generateToken(user.id);
    return { success: true, user: mapUser(user), token };
}

export async function login(usernameOrEmail, password) {
    const { data: user } = await supabase
        .from('users')
        .select('*')
        .or(`username.eq.${usernameOrEmail},email.eq.${usernameOrEmail}`)
        .limit(1)
        .maybeSingle();

    if (!user) return { success: false, error: 'Usuario no encontrado' };

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return { success: false, error: 'Contraseña incorrecta' };

    const { data: stats } = await supabase
        .from('user_stats')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

    const token = generateToken(user.id);
    return { success: true, user: mapUser(user, stats || {}), token };
}

export async function getUserById(userId) {
    const { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

    if (!user) return { success: false, error: 'Usuario no encontrado' };

    const { data: stats } = await supabase
        .from('user_stats')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

    return { success: true, user: mapUser(user, stats || {}) };
}

export async function updateStats(userId, stats) {
    const { data: current } = await supabase
        .from('user_stats')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

    if (!current) return { success: false, error: 'Usuario no encontrado' };

    const { error } = await supabase
        .from('user_stats')
        .update({
            games_played:  current.games_played  + (stats.gamesPlayed  || 0),
            games_won:     current.games_won     + (stats.gamesWon     || 0),
            hands_won:     current.hands_won     + (stats.handsWon     || 0),
            total_points:  current.total_points  + (stats.totalPoints  || 0),
            mesas_limpias: current.mesas_limpias + (stats.mesasLimpias || 0),
            cantes:        current.cantes        + (stats.cantes       || 0),
            last_played:   new Date().toISOString()
        })
        .eq('user_id', userId);

    if (error) return { success: false, error: 'Error guardando estadísticas' };
    return { success: true };
}

export async function resetStats(userId) {
    const { error } = await supabase
        .from('user_stats')
        .update({
            games_played: 0, games_won: 0, hands_won: 0,
            total_points: 0, mesas_limpias: 0, cantes: 0, last_played: null
        })
        .eq('user_id', userId);

    if (error) return { success: false, error: 'Error reseteando estadísticas' };
    return { success: true };
}

const LEADERBOARD_BLOCKED_NAMES = new Set(['admin', 'godmode']);

export async function getLeaderboard(limit = 20) {
    const { data } = await supabase
        .from('user_stats')
        .select('user_id, games_played, games_won, hands_won, total_points, mesas_limpias, users(username)')
        .order('games_won', { ascending: false })
        .limit(limit * 5);

    const leaderboard = (data || [])
        .filter(s => {
            const name = s.users?.username ?? '';
            return name.length >= 4 && !LEADERBOARD_BLOCKED_NAMES.has(name.toLowerCase());
        })
        .slice(0, limit)
        .map(s => ({
            id: s.user_id,
            username: s.users?.username ?? '?',
            gamesPlayed:  s.games_played,
            gamesWon:     s.games_won,
            handsWon:     s.hands_won,
            totalPoints:  s.total_points,
            mesasLimpias: s.mesas_limpias,
            winRate: s.games_played > 0 ? Math.round((s.games_won / s.games_played) * 100) : 0
        }));

    return { success: true, leaderboard };
}

const SKIN_THRESHOLDS = { default: 0, svg: 3, pokemon: 7, jyb: 12, dark: 20 };

export async function selectSkin(userId, skinId) {
    if (!Object.prototype.hasOwnProperty.call(SKIN_THRESHOLDS, skinId)) {
        return { success: false, error: 'Skin no válida' };
    }

    const { data: stats } = await supabase
        .from('user_stats')
        .select('games_won')
        .eq('user_id', userId)
        .maybeSingle();

    if (!stats) return { success: false, error: 'Usuario no encontrado' };

    if (stats.games_won < SKIN_THRESHOLDS[skinId]) {
        return { success: false, error: `Necesitas ${SKIN_THRESHOLDS[skinId]} victorias para esta skin` };
    }

    const { error } = await supabase
        .from('users')
        .update({ active_skin: skinId })
        .eq('id', userId);

    if (error) return { success: false, error: 'Error guardando skin' };
    return { success: true };
}

export async function ensureDefaultUsers() {
    const defaults = [
        { username: 'a',     email: 'a@a.a',              password: '111111',   extra: null },
        { username: 'b',     email: 'b@b.b',              password: '111111',   extra: null },
        { username: 'c',     email: 'c@c.c',              password: '111111',   extra: null },
        { username: 'd',     email: 'd@d.d',              password: '111111',   extra: null },
        { username: 'admin', email: 'admin@cuatrola.com', password: 'admin123', extra: { active_skin: 'dark' } },
    ];

    for (const u of defaults) {
        const { data: existing } = await supabase
            .from('users')
            .select('id')
            .eq('username', u.username)
            .maybeSingle();

        if (!existing) {
            const password_hash = await bcrypt.hash(u.password, SALT_ROUNDS);
            const row = { username: u.username, email: u.email, password_hash, ...(u.extra || {}) };
            const { data: newUser } = await supabase.from('users').insert(row).select().single();
            if (newUser) {
                await supabase.from('user_stats')
                    .update({ games_played: 30, games_won: 30 })
                    .eq('user_id', newUser.id);
            }
            console.log(`✅ Usuario por defecto creado: ${u.username}`);
        }
    }
}

export async function deleteAccount(userId) {
    // Eliminar estadísticas primero (foreign key)
    const { error: statsError } = await supabase
        .from('user_stats')
        .delete()
        .eq('user_id', userId);

    if (statsError) return { success: false, error: 'Error eliminando estadísticas' };

    // Eliminar usuario
    const { error: userError } = await supabase
        .from('users')
        .delete()
        .eq('id', userId);

    if (userError) return { success: false, error: 'Error eliminando usuario' };

    return { success: true };
}

export function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });

    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Token inválido' });

    req.userId = decoded.userId;
    next();
}
