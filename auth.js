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

function mapUser(u) {
    return {
        id: u.id,
        username: u.username,
        email: u.email,
        createdAt: u.created_at,
        activeSkin: u.active_skin,
        stats: {
            gamesPlayed: u.games_played,
            gamesWon: u.games_won,
            handsWon: u.hands_won,
            totalPoints: u.total_points,
            mesasLimpias: u.mesas_limpias,
            cantes: u.cantes,
            lastPlayed: u.last_played
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

    const token = generateToken(user.id);
    return { success: true, user: mapUser(user), token };
}

export async function getUserById(userId) {
    const { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

    if (!user) return { success: false, error: 'Usuario no encontrado' };
    return { success: true, user: mapUser(user) };
}

export async function updateStats(userId, stats) {
    const { data: user } = await supabase
        .from('users')
        .select('games_played, games_won, hands_won, total_points, mesas_limpias, cantes')
        .eq('id', userId)
        .maybeSingle();

    if (!user) return { success: false, error: 'Usuario no encontrado' };

    const { error } = await supabase
        .from('users')
        .update({
            games_played:  user.games_played  + (stats.gamesPlayed  || 0),
            games_won:     user.games_won     + (stats.gamesWon     || 0),
            hands_won:     user.hands_won     + (stats.handsWon     || 0),
            total_points:  user.total_points  + (stats.totalPoints  || 0),
            mesas_limpias: user.mesas_limpias + (stats.mesasLimpias || 0),
            cantes:        user.cantes        + (stats.cantes       || 0),
            last_played:   new Date().toISOString()
        })
        .eq('id', userId);

    if (error) return { success: false, error: 'Error guardando estadísticas' };
    return { success: true };
}

export async function resetStats(userId) {
    const { error } = await supabase
        .from('users')
        .update({
            games_played: 0, games_won: 0, hands_won: 0,
            total_points: 0, mesas_limpias: 0, cantes: 0, last_played: null
        })
        .eq('id', userId);

    if (error) return { success: false, error: 'Error guardando estadísticas' };
    return { success: true };
}

export async function getLeaderboard(limit = 20) {
    const { data: users } = await supabase
        .from('users')
        .select('id, username, games_played, games_won, hands_won, total_points, mesas_limpias')
        .order('games_won', { ascending: false })
        .limit(limit);

    const leaderboard = (users || []).map(u => ({
        id: u.id,
        username: u.username,
        gamesPlayed: u.games_played,
        gamesWon: u.games_won,
        handsWon: u.hands_won,
        totalPoints: u.total_points,
        mesasLimpias: u.mesas_limpias,
        winRate: u.games_played > 0 ? Math.round((u.games_won / u.games_played) * 100) : 0
    }));

    return { success: true, leaderboard };
}

const SKIN_THRESHOLDS = { default: 0, svg: 3, pokemon: 7, jyb: 12, dark: 20 };

export async function selectSkin(userId, skinId) {
    if (!Object.prototype.hasOwnProperty.call(SKIN_THRESHOLDS, skinId)) {
        return { success: false, error: 'Skin no válida' };
    }

    const { data: user } = await supabase
        .from('users')
        .select('games_won')
        .eq('id', userId)
        .maybeSingle();

    if (!user) return { success: false, error: 'Usuario no encontrado' };

    if (user.games_won < SKIN_THRESHOLDS[skinId]) {
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
        { username: 'admin', email: 'admin@cuatrola.com', password: 'admin123', extra: { games_won: 20, active_skin: 'dark' } },
    ];

    for (const u of defaults) {
        const { data: existing } = await supabase
            .from('users')
            .select('id, games_won')
            .eq('username', u.username)
            .maybeSingle();

        if (!existing) {
            const password_hash = await bcrypt.hash(u.password, SALT_ROUNDS);
            const row = { username: u.username, email: u.email, password_hash, ...u.extra };
            await supabase.from('users').insert(row);
            console.log(`✅ Usuario por defecto creado: ${u.username}`);
        } else if (u.username === 'admin' && existing.games_won < 20) {
            await supabase.from('users').update({ games_won: 20 }).eq('id', existing.id);
            console.log('✅ Admin actualizado a 20 victorias');
        }
    }
}

export function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });

    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Token inválido' });

    req.userId = decoded.userId;
    next();
}
