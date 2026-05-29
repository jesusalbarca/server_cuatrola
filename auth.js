import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const USERS_FILE = path.join(process.cwd(), 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'cuatrola-secret-key-change-in-production';
const SALT_ROUNDS = 10;

// Asegurar que el archivo de usuarios existe
function ensureUsersFile() {
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
    }
}

// Leer usuarios
function readUsers() {
    ensureUsersFile();
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error leyendo usuarios:', error);
        return { users: [] };
    }
}

// Guardar usuarios
function saveUsers(data) {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error guardando usuarios:', error);
        return false;
    }
}

// Generar token JWT
function generateToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

// Verificar token
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

// Registrar usuario
export async function register(username, email, password) {
    const data = readUsers();
    
    // Verificar si ya existe
    if (data.users.find(u => u.username === username || u.email === email)) {
        return { success: false, error: 'Usuario o email ya existe' };
    }
    
    // Hashear contraseña
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    
    // Crear usuario
    const user = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        username,
        email,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        stats: {
            gamesPlayed: 0,
            gamesWon: 0,
            handsWon: 0,
            totalPoints: 0,
            mesasLimpias: 0,
            cantes: 0
        }
    };
    
    data.users.push(user);
    
    if (!saveUsers(data)) {
        return { success: false, error: 'Error guardando usuario' };
    }
    
    const token = generateToken(user.id);
    const { password: _, ...userWithoutPassword } = user;
    
    return { success: true, user: userWithoutPassword, token };
}

// Login
export async function login(usernameOrEmail, password) {
    const data = readUsers();
    
    const user = data.users.find(u => 
        u.username === usernameOrEmail || u.email === usernameOrEmail
    );
    
    if (!user) {
        return { success: false, error: 'Usuario no encontrado' };
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
        return { success: false, error: 'Contraseña incorrecta' };
    }
    
    const token = generateToken(user.id);
    const { password: _, ...userWithoutPassword } = user;
    
    return { success: true, user: userWithoutPassword, token };
}

// Obtener perfil por token
export function getProfile(token) {
    const decoded = verifyToken(token);
    if (!decoded) {
        return { success: false, error: 'Token inválido' };
    }
    
    const data = readUsers();
    const user = data.users.find(u => u.id === decoded.userId);
    
    if (!user) {
        return { success: false, error: 'Usuario no encontrado' };
    }
    
    const { password: _, ...userWithoutPassword } = user;
    return { success: true, user: userWithoutPassword };
}

// Actualizar estadísticas
export function updateStats(userId, stats) {
    const data = readUsers();
    const userIndex = data.users.findIndex(u => u.id === userId);
    
    if (userIndex === -1) {
        return { success: false, error: 'Usuario no encontrado' };
    }
    
    const user = data.users[userIndex];
    
    // Actualizar stats
    user.stats.gamesPlayed += stats.gamesPlayed || 0;
    user.stats.gamesWon += stats.gamesWon || 0;
    user.stats.handsWon += stats.handsWon || 0;
    user.stats.totalPoints += stats.totalPoints || 0;
    user.stats.mesasLimpias += stats.mesasLimpias || 0;
    user.stats.cantes += stats.cantes || 0;
    user.stats.lastPlayed = new Date().toISOString();
    
    if (!saveUsers(data)) {
        return { success: false, error: 'Error guardando estadísticas' };
    }
    
    return { success: true };
}

// Resetear estadísticas a cero
export function resetStats(userId) {
    const data = readUsers();
    const userIndex = data.users.findIndex(u => u.id === userId);

    if (userIndex === -1) {
        return { success: false, error: 'Usuario no encontrado' };
    }

    data.users[userIndex].stats = {
        gamesPlayed: 0,
        gamesWon: 0,
        handsWon: 0,
        totalPoints: 0,
        mesasLimpias: 0,
        cantes: 0
    };

    if (!saveUsers(data)) {
        return { success: false, error: 'Error guardando estadísticas' };
    }

    return { success: true };
}

// Crear usuarios de prueba por defecto si no existen (se llama al arrancar el servidor)
export async function ensureDefaultUsers() {
    const defaults = [
        { username: 'a', email: 'a@a.a', password: '111111' },
        { username: 'b', email: 'b@b.b', password: '111111' },
        { username: 'c', email: 'c@c.c', password: '111111' },
        { username: 'd', email: 'd@d.d', password: '111111' },
    ];
    for (const u of defaults) {
        const data = readUsers();
        if (!data.users.find(x => x.username === u.username)) {
            await register(u.username, u.email, u.password);
            console.log(`✅ Usuario por defecto creado: ${u.username}`);
        }
    }
}

// Obtener ranking (top jugadores)
export function getLeaderboard(limit = 20) {
    const data = readUsers();
    
    const leaderboard = data.users
        .map(u => ({
            id: u.id,
            username: u.username,
            gamesPlayed: u.stats.gamesPlayed,
            gamesWon: u.stats.gamesWon,
            handsWon: u.stats.handsWon,
            totalPoints: u.stats.totalPoints,
            mesasLimpias: u.stats.mesasLimpias,
            winRate: u.stats.gamesPlayed > 0 ? Math.round((u.stats.gamesWon / u.stats.gamesPlayed) * 100) : 0
        }))
        .sort((a, b) => b.gamesWon - a.gamesWon || b.winRate - a.winRate)
        .slice(0, limit);
    
    return { success: true, leaderboard };
}

// Middleware para verificar token
export function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Token requerido' });
    }
    
    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'Token inválido' });
    }
    
    req.userId = decoded.userId;
    next();
}
