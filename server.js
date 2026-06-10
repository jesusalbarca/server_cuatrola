import express from "express";
import { Server as SocketServer } from "socket.io";
import http from 'http'
import cors from 'cors'
import morgan from 'morgan'
import { register, login, getUserById, verifyToken, updateStats, resetStats, getLeaderboard, selectSkin, authMiddleware, ensureDefaultUsers } from './auth.js';

// Logger con timestamp para producción
const timestamp = () => new Date().toISOString();
const log = (level, msg, data) => {
    const ts = timestamp();
    const dataStr = data ? JSON.stringify(data) : '';
    console.log(`[${ts}] [${level}] ${msg} ${dataStr}`);
};

const PORT = process.env.PORT || 4000

const app = express();
const server = http.createServer(app)
const io = new SocketServer(server, {
    cors:{
        origin: '*'
    }
})

app.use(cors())
app.use(express.json())
// Logging HTTP requests para Render
app.use(morgan(':method :url :status :response-time ms - :res[content-length]', {
    skip: (req) => req.url === '/health' // Skip health checks
}))

// Cartas disponibles para el juego
const cartasDisponibles = ['1DeOros', '3DeOros', '10DeOros', '11DeOros', '12DeOros',
                           '1DeCopas', '3DeCopas', '10DeCopas', '11DeCopas', '12DeCopas',
                           '1DeEspadas', '3DeEspadas', '10DeEspadas', '11DeEspadas', '12DeEspadas',
                           '1DeBastos', '3DeBastos', '10DeBastos', '11DeBastos', '12DeBastos'];

// Usuarios con permisos especiales (skip ronda)
const SUPER_USERS = new Set(['x', 'y', 'z']);

function esSuperUser(socketId, sala) {
    const jugador = sala.users.get(socketId);
    if (!jugador) return false;
    return SUPER_USERS.has(jugador.nombre);
}

// Función para repartir cartas
function repartirCartas() {
    const cartas = cartasDisponibles.slice();
    let cartas_jugadores = [[], [], [], []];
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 5; j++) {
            const cartaIndex = Math.floor(Math.random() * cartas.length);
            cartas_jugadores[i].push(cartas[cartaIndex]);
            cartas.splice(cartaIndex, 1);
        }
    }
    return cartas_jugadores;
}

// Función para obtener valor de carta
function valorCarta(carta) {
  const valorNumerico = parseInt(carta.match(/\d+/)[0], 10);
  switch (valorNumerico) {
    case 1: return 5;
    case 3: return 4;
    case 12: return 3;
    case 11: return 2;
    case 10: return 1;
    default: return valorNumerico;
  }
}

// Función para obtener palo de una carta (global para usar en bots y validación)
function getPalo(carta) {
    return carta.split('De')[1];
}

// Función para calcular ganador de ronda
function calcularGanadorRonda(ultimaCarta, cartasRonda, users) {
  console.log('🔍 calcularGanadorRonda - ultimaCarta:', ultimaCarta);
  console.log('🔍 calcularGanadorRonda - cartasRonda:', cartasRonda);
  
  if (!ultimaCarta || !cartasRonda || cartasRonda.length === 0) {
    console.error('❌ Datos inválidos para calcular ganador');
    return null;
  }
  
  const paloTriunfo = ultimaCarta.split('De')[1];
  console.log('🔍 Palo de triunfo:', paloTriunfo);
  
  const cartasFallo = cartasRonda.filter((carta) => carta.carta.endsWith(paloTriunfo));
  console.log('🔍 Cartas de fallo:', cartasFallo);
  
  if (cartasFallo.length > 0) {
    const cartaGanadora = cartasFallo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    const jugador = users.get(cartaGanadora.jugador);
    console.log('✅ Gana por fallo:', cartaGanadora);
    return { ...cartaGanadora, paloGanador: paloTriunfo, jugador_name: jugador ? jugador.nombre : 'Desconocido' };
  }
  
  // Si no hay fallo, usar el palo de la primera carta (palo de salida)
  const paloSalida = cartasRonda[0].carta.split('De')[1];
  console.log('🔍 Palo de salida:', paloSalida);
  
  const cartasMismoPalo = cartasRonda.filter((carta) => carta.carta.endsWith(paloSalida));
  console.log('🔍 Cartas del mismo palo:', cartasMismoPalo);
  
  if (cartasMismoPalo.length > 0) {
    const cartaGanadora = cartasMismoPalo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    const jugador = users.get(cartaGanadora.jugador);
    console.log('✅ Gana por palo:', cartaGanadora);
    return { ...cartaGanadora, paloGanador: paloSalida, jugador_name: jugador ? jugador.nombre : 'Desconocido' };
  }
  
  // Fallback: carta más alta
  const cartaGanadora = cartasRonda.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
  const jugador = users.get(cartaGanadora.jugador);
  console.log('✅ Gana por valor:', cartaGanadora);
  return { ...cartaGanadora, paloGanador: null, jugador_name: jugador ? jugador.nombre : 'Desconocido' };
}

// ===== SISTEMA DE SALAS =====
// 10 salas independientes
const salas = new Map();
const MAX_SALAS = 10;

// Inicializar salas
for (let i = 1; i <= MAX_SALAS; i++) {
    salas.set(`sala${i}`, {
        id: `sala${i}`,
        nombre: `Sala ${i}`,
        users: new Map(),
        cartasRonda: [],
        cartitasRonda: [],
        ultimaCarta: null,
        todos_limpian: 0,
        juegoIniciado: false,
        turnoActual: 0, // Índice del jugador al que le toca
        ordenJugadores: [], // Array con los socket IDs en orden de turno
        // Sistema de equipos y puntuación por RONDAS (manos)
        puntosRondaEquipoA: 0, // Puntos de RONDA ganados (a 7)
        puntosRondaEquipoB: 0, 
        equipoGanador: null,
        // Sistema de manos (5 bazas)
        cartasGanadasEquipoA: [], // Cartas acumuladas en la mano actual
        cartasGanadasEquipoB: [],
        bazasJugadasMano: 0, // Contador de bazas (0-5)
        ganadorUltimaBaza: null // Quién ganó la última baza para empezar la siguiente
    });
}

// Mapa de jugadores desconectados temporalmente (para reconexión)
// Clave: nombre+sala, Valor: { datos, salaId, timeout }
const jugadoresDesconectados = new Map();

// Sesiones activas: Clave: userId, Valor: token
const activeSessions = new Map();

// Función global para validar jugadas (disponible para bots y jugadores)
function validarJugadaGlobal(sala, jugador, carta) {
    const jugadorData = sala.users.get(jugador);
    if (!jugadorData) return { valida: false, mensaje: "Jugador no encontrado" };
    
    const cartasJugador = jugadorData.cartas;
    const paloCarta = getPalo(carta);
    const paloTriunfo = sala.ultimaCarta ? getPalo(sala.ultimaCarta) : null;
    
    // Si es el primero en jugar (no hay cartas en mesa), cualquier carta es válida
    if (sala.cartasRonda.length === 0) {
        return { valida: true };
    }
    
    // Obtener palo de salida (palo de la primera carta jugada)
    const paloSalida = getPalo(sala.cartasRonda[0].carta);
    
    // Si la carta es del palo de salida, verificar si debe superar
    if (paloCarta === paloSalida) {
        const cartasPaloEnMesa = sala.cartasRonda.filter(j => getPalo(j.carta) === paloSalida);
        if (cartasPaloEnMesa.length > 0) {
            const mayorCartaEnMesa = Math.max(...cartasPaloEnMesa.map(j => valorCarta(j.carta)));
            const valorMiCarta = valorCarta(carta);
            const misCartasDelPalo = cartasJugador.filter(c => getPalo(c) === paloSalida).map(c => valorCarta(c));
            const puedoSuperar = misCartasDelPalo.some(v => v > mayorCartaEnMesa);
            
            if (valorMiCarta > mayorCartaEnMesa) {
                return { valida: true };
            } else if (puedoSuperar) {
                return {
                    valida: false,
                    mensaje: `Debes asistir superando: tienes cartas del palo ${paloSalida} que superan la mesa.`
                };
            }
        }
        return { valida: true };
    }
    
    // Si no es del palo de salida, verificar si tiene cartas del palo de salida
    const tienePaloSalida = cartasJugador.some(c => getPalo(c) === paloSalida);
    if (tienePaloSalida) {
        return { 
            valida: false, 
            mensaje: `Debes asistir: tienes cartas del palo de ${paloSalida}. Obligado a jugar ese palo.` 
        };
    }
    
    // No tiene palo de salida. Verificar situación de triunfo (fallo)
    const tieneTriunfo = cartasJugador.some(c => getPalo(c) === paloTriunfo);
    const cartasTriunfoEnMesa = sala.cartasRonda.filter(j => getPalo(j.carta) === paloTriunfo);
    const hayTriunfoEnMesa = cartasTriunfoEnMesa.length > 0;
    
    if (paloTriunfo && paloCarta === paloTriunfo) {
        if (hayTriunfoEnMesa) {
            const mayorTriunfoEnMesa = Math.max(...cartasTriunfoEnMesa.map(j => valorCarta(j.carta)));
            const valorMiTriunfo = valorCarta(carta);
            const misTriunfos = cartasJugador.filter(c => getPalo(c) === paloTriunfo).map(c => valorCarta(c));
            const puedoSuperar = misTriunfos.some(v => v > mayorTriunfoEnMesa);
            
            if (valorMiTriunfo > mayorTriunfoEnMesa) {
                return { valida: true, esFallo: true };
            } else if (puedoSuperar) {
                return {
                    valida: false,
                    mensaje: `Debes fallar superando: tienes triunfos que superan el ${mayorTriunfoEnMesa} en mesa.`
                };
            } else {
                return { valida: true, esFallo: true };
            }
        } else {
            return { valida: true, esFallo: true };
        }
    }
    
    // No está jugando triunfo. Verificar si debe fallar obligatoriamente
    if (tieneTriunfo) {
        if (hayTriunfoEnMesa) {
            const mayorTriunfoEnMesa = Math.max(...cartasTriunfoEnMesa.map(j => valorCarta(j.carta)));
            const misTriunfos = cartasJugador.filter(c => getPalo(c) === paloTriunfo).map(c => valorCarta(c));
            const puedoSuperar = misTriunfos.some(v => v > mayorTriunfoEnMesa);
            
            if (puedoSuperar) {
                return {
                    valida: false,
                    mensaje: `Debes fallar superando: tienes triunfos (${paloTriunfo}) que superan el ${mayorTriunfoEnMesa} en mesa.`
                };
            }
            return { valida: true, esDescarte: true };
        } else {
            return {
                valida: false,
                mensaje: `Debes fallar: tienes triunfos (${paloTriunfo}) y no hay triunfo en mesa.`
            };
        }
    }
    
    // No tiene palo de salida ni triunfos, puede jugar cualquier otra carta
    return { valida: true, esDescarte: true };
}

// ===== SISTEMA DE BOTS =====
// Mapa para rastrear bots activos: clave = botId, valor = { salaId, datos }
const botsActivos = new Map();
let botCounter = 0;

// Nombres de bots disponibles
const nombresBots = ['🤖 Bot Rápido', '🤖 Bot Listo', '🤖 Bot Astuto', '🤖 Bot Maestro', '🤖 Bot Experto', '🤖 Bot Genio', '🤖 Bot Crack', '🤖 Bot Pro'];

// Función para crear un bot y añadirlo a una sala
function crearBot(sala) {
    botCounter++;
    const botId = `bot_${Date.now()}_${botCounter}`;
    const nombreBot = nombresBots[(botCounter - 1) % nombresBots.length];
    
    const datosBot = {
        nombre: nombreBot,
        cartas: [],
        socketId: botId,
        esBot: true,
        equipo: null,
        numeroJugador: null
    };
    
    // Añadir bot a la sala
    sala.users.set(botId, datosBot);
    sala.ordenJugadores.push(botId);
    
    // Guardar referencia
    botsActivos.set(botId, { salaId: sala.id, datos: datosBot });
    
    console.log(`🤖 Bot creado: ${nombreBot} (${botId}) en ${sala.id}. Jugadores: ${sala.users.size}/4`);
    
    return { botId, datosBot };
}

// Función para eliminar bots de una sala
function eliminarBotsDeSala(sala) {
    for (const [botId, info] of botsActivos.entries()) {
        if (info.salaId === sala.id) {
            sala.users.delete(botId);
            const idx = sala.ordenJugadores.indexOf(botId);
            if (idx !== -1) sala.ordenJugadores.splice(idx, 1);
            botsActivos.delete(botId);
            console.log(`🤖 Bot eliminado: ${botId} de ${sala.id}`);
        }
    }
}

// Función para contar jugadores reales (no bots)
function contarJugadoresReales(sala) {
    let count = 0;
    for (const [id, datos] of sala.users.entries()) {
        if (!datos.esBot) count++;
    }
    return count;
}

// Función para que un bot haga su apuesta
function botRealizarApuesta(sala, botId) {
    const bot = sala.users.get(botId);
    if (!bot || !bot.esBot) return;
    
    // Los bots siempre pasan - no pueden hacer apuestas de solo/cuatrola/quintola
    const tipoApuesta = 'paso';
    
    console.log(`🤖 ${bot.nombre} pasa (bots solo pueden pasar)`);
    
    // Simular delay para que parezca más natural
    setTimeout(() => {
        // Emitir evento de apuesta simulado
        io.to(sala.id).emit("apuesta_realizada", {
            id: Date.now() + '_' + botId,
            jugador: bot.nombre,
            tipo: tipoApuesta,
            mensaje: tipoApuesta === 'paso' ? `${bot.nombre} PASA` : `${bot.nombre} apuesta ${tipoApuesta.toUpperCase()}`
        });
        
        // Procesar la apuesta
        if (tipoApuesta === 'paso') {
            sala.jugadoresPasaron.add(botId);
        } else {
            const apuesta = {
                jugador: botId,
                jugadorName: bot.nombre,
                tipo: tipoApuesta,
                equipo: bot.equipo,
                valor: tipoApuesta === 'solo' ? 2 : (tipoApuesta === 'cuatrola' ? 4 : 5)
            };
            sala.apuestas.push(apuesta);
            sala.apuestaActual = apuesta;
            
            // Si es solo/cuatrola/quintola, termina la fase de apuestas
            if (tipoApuesta === 'solo' || tipoApuesta === 'cuatrola' || tipoApuesta === 'quintola') {
                sala.cuatrolaActiva = apuesta;
                const idx = sala.ordenJugadores.indexOf(botId);
                sala.compañeroNoJuega = sala.ordenJugadores[(idx + 2) % 4];
                sala.cuatrolaBazasGanadas = 0;
                
                sala.faseApuestas = false;
                iniciarJuegoConApuesta(sala, sala.id);
                return;
            }
        }
        
        // Verificar si todos han apostado
        const totalRespuestas = sala.apuestas.length + sala.jugadoresPasaron.size;
        if (sala.jugadoresPasaron.size === 4) {
            sala.faseApuestas = false;
            iniciarJuegoNormal(sala, sala.id);
            return;
        }
        
        if (totalRespuestas >= 4) {
            sala.faseApuestas = false;
            iniciarJuegoConApuesta(sala, sala.id);
            return;
        }
        
        // Pasar al siguiente turno
        const siguienteIdx = totalRespuestas % 4;
        const siguienteId = sala.ordenJugadores[(sala.manoIndex + 1 + siguienteIdx) % 4];
        const siguiente = sala.users.get(siguienteId);
        
        io.to(sala.id).emit("turno_apuesta", {
            jugadorId: siguienteId,
            jugadorNombre: siguiente ? siguiente.nombre : '',
            apuestaActual: sala.apuestaActual,
            mensaje: `Turno de ${siguiente ? siguiente.nombre : ''}`
        });
        
        // Si el siguiente es un bot, que apueste también
        if (siguiente && siguiente.esBot) {
            setTimeout(() => botRealizarApuesta(sala, siguienteId), 1500);
        }
    }, 1000 + Math.random() * 1000); // Delay aleatorio entre 1-2 segundos
}

// Función para iniciar una nueva mano (repartir cartas nuevas) - MOVIDA a scope global
function nuevaMano(sala) {
    console.log(`🆕 Nueva mano en ${sala.id} - iniciando fase de apuestas`);
    
    // El mano pasa al jugador de la derecha (siguiente en orden)
    // El que gana la última baza era el mano de esta mano, ahora pasa al siguiente
    sala.manoIndex = (sala.manoIndex + 1) % 4;
    sala.turnoActual = (sala.manoIndex + 1) % 4; // El que baraja tiene el fallo, el siguiente empieza
    
    console.log(`🎲 Nuevo mano: índice ${sala.manoIndex}, jugador ${sala.ordenJugadores[sala.manoIndex]}`);
    
    // Resetear cartas ganadas y contadores de bazas
    sala.cartasGanadasEquipoA = [];
    sala.cartasGanadasEquipoB = [];
    sala.bazasJugadasMano = 0;
    sala.bazasGanadasPorEquipo = { A: 0, B: 0 };
    sala.cartasRonda = [];
    sala.cartitasRonda = [];
    
    // Resetear sistema de apuestas para la nueva mano
    sala.faseApuestas = true;
    sala.apuestas = [];
    sala.apuestaActual = null;
    sala.historialApuestas = [];
    sala.turnoApuesta = null;
    sala.jugadoresPasaron.clear();
    sala.cuatrolaActiva = null;
    sala.compañeroNoJuega = null;
    sala.cuatrolaBazasGanadas = 0;
    sala.juegoActivo = false;
    
    // Resetear cantes para la nueva mano
    sala.palosCantados = { A: [], B: [] };
    
    // Repartir nuevas cartas
    let arrayCartitas = repartirCartas();
    let i = 0;
    
    sala.users.forEach((valor, clave) => {
        valor.cartas = arrayCartitas[i];
        valor.noJuega = false; // Resetear flag de no jugar
        i++;
    });
    
    sala.ultimaCarta = arrayCartitas[sala.manoIndex][4];
    const usersArray = Array.from(sala.users);
    
    // El que baraja tiene el fallo pero NO empieza; empieza el siguiente
    const primerTurno = sala.ordenJugadores[(sala.manoIndex + 1) % 4];
    const primerJugador = sala.users.get(primerTurno);
    
    // Enviar cartas a cada jugador ANTES de la fase de apuestas
    sala.users.forEach((valor, clave) => {
        io.to(clave).emit('mis_cartas_apuestas', {
            cartas: valor.cartas,
            ultimaCarta: sala.ultimaCarta,
            mensaje: 'Tus cartas para decidir tu apuesta'
        });
    });
    
    // Iniciar fase de apuestas (igual que al inicio del juego)
    const jugadoresInfo = sala.ordenJugadores.map(id => {
        const j = sala.users.get(id);
        return { id, nombre: j ? j.nombre : '', equipo: j ? j.equipo : '' };
    });
    
    console.log(`📤 Emitiendo fase_apuestas - mano: ${primerTurno}, turnoApuesta: ${primerTurno}, manoIndex: ${sala.manoIndex}`);
    
    // Jugador que tiene el fallo (quien baraja = manoIndex)
    const jugadorFalloNuevaMano = sala.users.get(sala.ordenJugadores[sala.manoIndex]);
    sala.jugadorFalloNombre = jugadorFalloNuevaMano ? jugadorFalloNuevaMano.nombre : '';
    sala.turnoApuesta = primerTurno;
    
    io.to(sala.id).emit('fase_apuestas', {
        jugadores: jugadoresInfo,
        mano: { id: primerTurno, nombre: primerJugador ? primerJugador.nombre : '' },
        turnoApuesta: primerTurno,
        ordenApuestas: sala.ordenJugadores,
        mensaje: 'Fase de apuestas: Elige Solo (2pts), Cuatrola (4pts), Quintola (5pts), o Paso',
        puntosRondaA: sala.puntosRondaEquipoA,
        puntosRondaB: sala.puntosRondaEquipoB,
        jugadorFalloNombre: jugadorFalloNuevaMano ? jugadorFalloNuevaMano.nombre : '',
        jugadorFalloId: sala.ordenJugadores[sala.manoIndex]
    });
    
    // Si el primer jugador en apostar es un bot, hacer que apueste automáticamente
    if (primerJugador && primerJugador.esBot) {
        setTimeout(() => botRealizarApuesta(sala, primerTurno), 2000);
    }
}

// Función para iniciar juego normal (SCOPE GLOBAL - llamada desde procesarFinBaza)
function iniciarJuegoNormal(sala, salaId) {
    console.log(`🎮 iniciarJuegoNormal (global) - sala: ${salaId}, manoIndex: ${sala.manoIndex}`);
    
    const jugadoresArray = Array.from(sala.users.entries());
    const jugadoresInfo = jugadoresArray.map(([id, data]) => ({
        id, nombre: data.nombre, equipo: data.equipo, cartas: data.cartas
    }));
    
    // El que baraja (manoIndex) tiene el fallo pero NO empieza; empieza el siguiente
    const primerTurnoIndex = (sala.manoIndex + 1) % 4;
    const primerJugador = sala.users.get(sala.ordenJugadores[primerTurnoIndex]);
    
    // Construir equiposInfo correctamente (sala.users es un Map)
    const equiposInfo = {};
    sala.users.forEach((data, id) => {
        equiposInfo[id] = { equipo: data.equipo, numero: data.numeroJugador };
    });
    
    const primerTurnoId = sala.ordenJugadores[primerTurnoIndex];
    
    console.log(`🎮 Emitiendo start_game - primer turno: ${primerTurnoId}, jugador: ${primerJugador ? primerJugador.nombre : 'unknown'}`);
    
    io.to(salaId).emit("start_game", 
        jugadoresInfo, 
        sala.ultimaCarta, 
        primerTurnoId,
        primerJugador ? primerJugador.nombre : '',
        equiposInfo
    );
    sala.juegoActivo = true;
    
    // Inicializar el turno actual para la nueva mano
    sala.turnoActual = primerTurnoIndex;
    
    // Si el primer jugador es un bot, hacer que juegue automáticamente
    if (primerJugador && primerJugador.esBot) {
        console.log(`🤖 Primer jugador es bot: ${primerJugador.nombre}, cartas: ${primerJugador.cartas?.length || 0}`);
        setTimeout(() => botJugarCarta(sala, primerTurnoId), 2000);
    } else {
        console.log(`👤 Primer jugador es humano: ${primerJugador ? primerJugador.nombre : 'unknown'}`);
    }
}

// Función para forzar el fin de una mano y asignar victoria al equipo del jugador
function skipMano(sala, salaId, socketId) {
    console.log(`⚡ SKIP MANO ejecutado por ${socketId} en ${salaId}`);
    
    const jugador = sala.users.get(socketId);
    if (!jugador) return false;
    
    const equipoJugador = jugador.equipo;
    const bazasRestantes = 5 - sala.bazasJugadasMano;
    
    // Dar montes y marcar bazas ganadas
    if (equipoJugador === 'A') {
        sala.cartasGanadasEquipoA.push('DIEZ_MONTES_10');
    } else {
        sala.cartasGanadasEquipoB.push('DIEZ_MONTES_10');
    }
    
    sala.bazasJugadasMano = 5;
    if (!sala.bazasGanadasPorEquipo) sala.bazasGanadasPorEquipo = { A: 0, B: 0 };
    sala.bazasGanadasPorEquipo[equipoJugador] += bazasRestantes;
    
    sala.cartasRonda = [];
    sala.cartitasRonda = [];
    
    // Notificar skip ejecutado
    io.to(salaId).emit("skip_ejecutado", {
        jugador: jugador.nombre,
        equipo: equipoJugador,
        mensaje: `⚡ ${jugador.nombre} usó SKIP - Equipo ${equipoJugador} gana la mano`
    });
    
    procesarFinMano(sala, salaId);
    return true;
}

// Función para que un bot juegue una carta
function botJugarCarta(sala, botId) {
    console.log(`🤖 botJugarCarta llamado - botId: ${botId}, sala: ${sala.id}`);
    
    const bot = sala.users.get(botId);
    if (!bot || !bot.esBot) {
        console.log(`❌ botJugarCarta: bot no encontrado o no es bot`);
        return;
    }
    
    const cartasJugador = bot.cartas;
    console.log(`🤖 botJugarCarta: ${bot.nombre} tiene ${cartasJugador?.length || 0} cartas`);
    
    if (!cartasJugador || cartasJugador.length === 0) {
        console.log(`❌ botJugarCarta: bot no tiene cartas`);
        return;
    }
    
    let cartaAJugar = null;
    
    // Si es el primero en jugar (no hay cartas en mesa)
    if (sala.cartasRonda.length === 0) {
        // Jugar la carta de menor valor
        cartaAJugar = cartasJugador.reduce((min, carta) => {
            return valorCarta(carta) < valorCarta(min) ? carta : min;
        }, cartasJugador[0]);
    } else {
        // Hay cartas en mesa, seguir reglas
        const paloSalida = sala.cartasRonda[0].carta.split('De')[1];
        const paloTriunfo = sala.ultimaCarta ? sala.ultimaCarta.split('De')[1] : null;
        
        const cartasDelPalo = cartasJugador.filter(c => c.endsWith(paloSalida));
        
        if (cartasDelPalo.length > 0) {
            // Tiene del palo de salida - jugar la más baja
            cartaAJugar = cartasDelPalo.reduce((min, carta) => {
                return valorCarta(carta) < valorCarta(min) ? carta : min;
            }, cartasDelPalo[0]);
        } else {
            // No tiene del palo, buscar triunfo
            const cartasTriunfo = cartasJugador.filter(c => c.endsWith(paloTriunfo));
            if (cartasTriunfo.length > 0) {
                // Jugar el triunfo más bajo
                cartaAJugar = cartasTriunfo.reduce((min, carta) => {
                    return valorCarta(carta) < valorCarta(min) ? carta : min;
                }, cartasTriunfo[0]);
            } else {
                // No tiene triunfo, jugar carta más baja de cualquier palo
                cartaAJugar = cartasJugador.reduce((min, carta) => {
                    return valorCarta(carta) < valorCarta(min) ? carta : min;
                }, cartasJugador[0]);
            }
        }
    }
    
    console.log(`🤖 ${bot.nombre} juega: ${cartaAJugar}`);
    
    // Ejecutar la jugada
    setTimeout(() => {
        // Verificar que sigue siendo el turno de este bot (podría haber cambiado si el juego avanzó)
        if (sala.ordenJugadores[sala.turnoActual] !== botId) {
            console.log(`⚠️ botJugarCarta (timeout): ya no es el turno de ${bot.nombre}, ignorando`);
            return;
        }
        // Releer cartas actuales del bot (puede haber cambiado desde que se programó el timeout)
        const cartasActuales = bot.cartas;
        if (!cartasActuales || cartasActuales.length === 0) {
            console.log(`❌ botJugarCarta (timeout): ${bot.nombre} ya no tiene cartas`);
            return;
        }
        // Si la carta seleccionada ya no está disponible, recalcular
        if (!cartasActuales.includes(cartaAJugar)) {
            cartaAJugar = cartasActuales[0];
        }
        // Validar jugada usando la función global
        const validacion = validarJugadaGlobal(sala, botId, cartaAJugar);
        if (!validacion.valida) {
            console.log(`🤖 ${bot.nombre} jugada inválida: ${validacion.mensaje}. Intentando otra carta...`);
            let cartaValidaEncontrada = false;
            for (const otraCarta of cartasActuales) {
                const val = validarJugadaGlobal(sala, botId, otraCarta);
                if (val.valida) {
                    cartaAJugar = otraCarta;
                    cartaValidaEncontrada = true;
                    break;
                }
            }
            if (!cartaValidaEncontrada) {
                console.error(`🤖 ${bot.nombre} no tiene cartas válidas, forzando primera carta`);
                cartaAJugar = cartasActuales[0];
            }
        }

        // Realizar la jugada
        let jugada = { jugador: botId, carta: cartaAJugar };
        sala.cartasRonda.push(jugada);

        // Quitar carta del bot (inmutable, igual que jugadores humanos)
        const botActualizado = Object.assign({}, bot);
        botActualizado.cartas = bot.cartas.filter(c => c !== cartaAJugar);
        sala.users.set(botId, botActualizado);
        
        // Emitir actualización de cartas a todos (igual que en carta_seleccionada)
        const usersArray = Array.from(sala.users);
        io.to(sala.id).emit("quitar_carta_usuario", usersArray);
        
        sala.cartitasRonda.push(cartaAJugar);
        io.to(sala.id).emit("mostrar_cartas_mesa", sala.cartitasRonda);
        
        // Avanzar turno
        sala.turnoActual = (sala.turnoActual + 1) % 4;
        while (sala.compañeroNoJuega && sala.ordenJugadores[sala.turnoActual] === sala.compañeroNoJuega) {
            sala.turnoActual = (sala.turnoActual + 1) % 4;
        }
        
        const siguienteTurnoId = sala.ordenJugadores[sala.turnoActual];
        const siguienteJugador = sala.users.get(siguienteTurnoId);
        
        // Verificar si todos jugaron
        const cartasNecesarias = sala.compañeroNoJuega ? 3 : 4;
        if (sala.cartasRonda.length === cartasNecesarias) {
            procesarFinBaza(sala, sala.id);
        } else {
            // Notificar cambio de turno solo cuando la baza NO está completa
            io.to(sala.id).emit("cambio_turno", siguienteTurnoId, siguienteJugador ? siguienteJugador.nombre : '');
            if (siguienteJugador && siguienteJugador.esBot) {
                setTimeout(() => botJugarCarta(sala, siguienteTurnoId), 1500);
            }
        }
    }, 1500 + Math.random() * 1000);
}

// Función para procesar el fin de baza (extraer la lógica reutilizable)
function procesarFinBaza(sala, salaId) {
    console.log(`🎲 Calculando ganador de baza ${sala.bazasJugadasMano + 1}/5`);
    
    let ganador_baza;
    try {
        ganador_baza = calcularGanadorRonda(sala.ultimaCarta, sala.cartasRonda, sala.users);
        console.log('✅ Ganador calculado:', ganador_baza);
    } catch (error) {
        console.error('❌ Error al calcular ganador:', error);
        ganador_baza = { 
            jugador: sala.cartasRonda[0].jugador, 
            carta: sala.cartasRonda[0].carta,
            jugador_name: sala.users.get(sala.cartasRonda[0].jugador)?.nombre || 'Desconocido'
        };
    }
    
    // Acumular cartas ganadas al equipo correspondiente
    const jugadorGanador = sala.users.get(ganador_baza.jugador);
    const cartasDeLaBaza = sala.cartasRonda.map(j => j.carta);
    const esUltimaBaza = sala.bazasJugadasMano + 1 >= 5;
    
    if (jugadorGanador) {
        if (jugadorGanador.equipo === 'A') {
            sala.cartasGanadasEquipoA.push(...cartasDeLaBaza);
            if (esUltimaBaza) sala.cartasGanadasEquipoA.push('DIEZ_MONTES_10');
        } else {
            sala.cartasGanadasEquipoB.push(...cartasDeLaBaza);
            if (esUltimaBaza) sala.cartasGanadasEquipoB.push('DIEZ_MONTES_10');
        }
    }
    
    sala.bazasJugadasMano++;
    sala.ganadorUltimaBaza = ganador_baza.jugador;
    
    // Conteo de bazas por equipo
    if (!sala.bazasGanadasPorEquipo) sala.bazasGanadasPorEquipo = { A: 0, B: 0 };
    if (jugadorGanador) sala.bazasGanadasPorEquipo[jugadorGanador.equipo]++;
    
    // Calcular palo de triunfo
    const paloTriunfo = sala.ultimaCarta ? sala.ultimaCarta.split('De')[1] : null;
    
    // Verificar si algún jugador del equipo ganador puede cantar
    const jugadoresQuePuedenCantar = [];
    // En cuatrola/quintola nadie puede cantar (la mano se gana por bazas, no por cantes)
    const hayCuatrolaOQuintola = sala.cuatrolaActiva &&
        (sala.cuatrolaActiva.tipo === 'cuatrola' || sala.cuatrolaActiva.tipo === 'quintola');
    const puedeCantarEnSiguienteBaza = sala.bazasJugadasMano >= 1 && sala.bazasJugadasMano <= 3 && !hayCuatrolaOQuintola;
    
    if (puedeCantarEnSiguienteBaza && jugadorGanador) {
        const equipoGanador = jugadorGanador.equipo;
        // Filtrar jugadores del equipo ganador, excluyendo al compañero que no juega (solo/cuatrola/quintola)
        const jugadoresDelEquipo = Array.from(sala.users.entries()).filter(([id, data]) => {
            // Debe ser del equipo ganador
            if (data.equipo !== equipoGanador) return false;
            // No debe ser el compañero que no juega
            if (sala.compañeroNoJuega && id === sala.compañeroNoJuega) return false;
            return true;
        });
        
        if (!sala.palosCantados) {
            sala.palosCantados = { A: [], B: [] };
        }
        
        function verificarCantar(cartasJugador) {
            const palos = ['Bastos', 'Copas', 'Espadas', 'Oros'];
            const opciones = [];
            for (const palo of palos) {
                if (sala.palosCantados[equipoGanador].includes(palo)) continue;
                const tiene11 = cartasJugador.some(c => c === `11De${palo}`);
                const tiene12 = cartasJugador.some(c => c === `12De${palo}`);
                if (tiene11 && tiene12) {
                    const esPaloTriunfo = paloTriunfo && palo === paloTriunfo;
                    opciones.push({ palo, esTriunfo: esPaloTriunfo, puntos: esPaloTriunfo ? 40 : 20 });
                }
            }
            return opciones;
        }
        
        for (const [id, data] of jugadoresDelEquipo) {
            const opciones = verificarCantar(data.cartas);
            if (opciones.length > 0) {
                jugadoresQuePuedenCantar.push({
                    jugadorId: id,
                    jugadorName: data.nombre,
                    opciones,
                    // Compat: exponer el primer/mejor canto directamente
                    palo: opciones[0].palo,
                    esTriunfo: opciones[0].esTriunfo,
                    puntos: opciones[0].puntos
                });
            }
        }
    }
    
    // Calcular puntos de cartas acumulados por cada equipo en esta mano
    function calcularPuntosCartas(cartasGanadas) {
        return cartasGanadas.reduce((sum, carta) => {
            if (carta === 'DIEZ_MONTES_10') return sum + 10;
            if (carta.startsWith('CANTO_')) {
                const partes = carta.split('_');
                return sum + (parseInt(partes[2]) || 0);
            }
            const match = carta.match(/\d+/);
            if (!match) return sum;
            const num = parseInt(match[0]);
            switch(num) {
                case 1: return sum + 11;
                case 3: return sum + 10;
                case 10: return sum + 2;
                case 11: return sum + 3;
                case 12: return sum + 4;
                default: return sum;
            }
        }, 0);
    }
    
    const puntosCartasA = calcularPuntosCartas(sala.cartasGanadasEquipoA);
    const puntosCartasB = calcularPuntosCartas(sala.cartasGanadasEquipoB);
    
    // Notificar fin de baza
    console.log('📢 Emitiendo fin_baza a sala:', salaId);
    io.to(salaId).emit("fin_baza", {
        ganador: ganador_baza,
        bazasJugadas: sala.bazasJugadasMano,
        totalBazas: 5,
        jugadoresQuePuedenCantar: jugadoresQuePuedenCantar,
        paloTriunfo: paloTriunfo,
        bazasPorEquipo: sala.bazasGanadasPorEquipo || { A: 0, B: 0 },
        puntosCartasPorEquipo: { A: puntosCartasA, B: puntosCartasB }
    });
    
    // Limpiar mesa
    sala.cartasRonda = [];
    sala.cartitasRonda = [];

    // Si no terminó la mano, iniciar siguiente baza
    if (sala.bazasJugadasMano < 5) {
        const indexGanador = sala.ordenJugadores.indexOf(ganador_baza.jugador);
        if (indexGanador !== -1) {
            sala.turnoActual = indexGanador;
            const primerTurnoId = sala.ordenJugadores[sala.turnoActual];
            const primerJugador = sala.users.get(primerTurnoId);

            // Guardar el número de baza actual para detectar si alguien juega antes del timeout
            const bazaAlIniciar = sala.bazasJugadasMano;

            console.log(`🎮 Nueva baza iniciada. Primer turno: ${primerJugador ? primerJugador.nombre : 'unknown'}`);

            // Emitir cambio_turno INMEDIATAMENTE para que todos sepan a quién le toca
            // (ya no se espera el timeout de 3 segundos para esto)
            io.to(salaId).emit("cambio_turno", primerTurnoId, primerJugador ? primerJugador.nombre : '');

            setTimeout(() => {
                // Si ya se jugó una carta en la nueva baza, no limpiar la mesa (el jugador ya jugó)
                if (sala.cartasRonda.length > 0 || sala.bazasJugadasMano !== bazaAlIniciar) {
                    console.log(`⚠️ Timeout baza ignorado: ya hay ${sala.cartasRonda.length} cartas en mesa o baza avanzó`);
                    return;
                }
                io.to(salaId).emit("vaciar_mesa");

                if (primerJugador && primerJugador.esBot) {
                    setTimeout(() => botJugarCarta(sala, primerTurnoId), 500);
                }
            }, 1500);
        }
    } else {
        // Fin de MANO (5 bazas completadas)
        procesarFinMano(sala, salaId);
    }
    
    return ganador_baza;
}

// Función para procesar el fin de mano (5 bazas)
function procesarFinMano(sala, salaId) {
    console.log(`🏁 Fin de mano en sala ${salaId}`);
    
    // Calcular puntos de cartas
    function puntosCarta(carta) {
        if (carta === 'DIEZ_MONTES_10') return 10;
        if (carta.startsWith('CANTO_')) {
            const partes = carta.split('_');
            return parseInt(partes[2]) || 0;
        }
        const num = parseInt(carta.match(/\d+/)[0]);
        switch(num) {
            case 1: return 11;
            case 3: return 10;
            case 10: return 2;
            case 11: return 3;
            case 12: return 4;
            default: return 0;
        }
    }
    
    const puntosA = sala.cartasGanadasEquipoA.reduce((sum, carta) => sum + puntosCarta(carta), 0);
    const puntosB = sala.cartasGanadasEquipoB.reduce((sum, carta) => sum + puntosCarta(carta), 0);
    
    // Mesa limpia
    const mesaLimpia = sala.bazasGanadasPorEquipo &&
        (sala.bazasGanadasPorEquipo.A === 5 || sala.bazasGanadasPorEquipo.B === 5);
    const equipoMesaLimpia = mesaLimpia ?
        (sala.bazasGanadasPorEquipo.A === 5 ? 'A' : 'B') : null;
    
    // Determinar ganador
    let ganadorRonda = null;
    let puntosRondaGanados = 1;
    const bazasA = sala.bazasGanadasPorEquipo ? sala.bazasGanadasPorEquipo.A : 0;
    const bazasB = sala.bazasGanadasPorEquipo ? sala.bazasGanadasPorEquipo.B : 0;
    
    if (sala.cuatrolaActiva) {
        const tipoApuesta = sala.cuatrolaActiva.tipo;
        const equipoApuesta = sala.cuatrolaActiva.equipo;
        const equipoContrario = equipoApuesta === 'A' ? 'B' : 'A';
        const bazasEquipoApuesta = equipoApuesta === 'A' ? bazasA : bazasB;
        
        let ganoApuesta = false;
        if (tipoApuesta === 'solo') {
            const puntosEquipoApuesta = equipoApuesta === 'A' ? puntosA : puntosB;
            const puntosContrario = equipoApuesta === 'A' ? puntosB : puntosA;
            ganoApuesta = puntosEquipoApuesta > puntosContrario;
            puntosRondaGanados = 2;
        } else if (tipoApuesta === 'cuatrola') {
            ganoApuesta = bazasEquipoApuesta >= 4;
            puntosRondaGanados = 4;
        } else if (tipoApuesta === 'quintola') {
            ganoApuesta = bazasEquipoApuesta === 5;
            puntosRondaGanados = 5;
        }
        
        ganadorRonda = ganoApuesta ? equipoApuesta : equipoContrario;
    } else if (puntosA > puntosB) {
        ganadorRonda = 'A';
    } else if (puntosB > puntosA) {
        ganadorRonda = 'B';
    } else {
        ganadorRonda = 'EMPATE';
    }
    
    // Asignar puntos
    if (ganadorRonda !== 'EMPATE') {
        if (ganadorRonda === 'A') {
            // Mesa limpia da 2 puntos, no 3 (sobrescribe el punto normal)
            if (!sala.cuatrolaActiva && mesaLimpia && equipoMesaLimpia === 'A') {
                sala.puntosRondaEquipoA += 2;
            } else {
                sala.puntosRondaEquipoA += puntosRondaGanados;
            }
        } else {
            // Mesa limpia da 2 puntos, no 3 (sobrescribe el punto normal)
            if (!sala.cuatrolaActiva && mesaLimpia && equipoMesaLimpia === 'B') {
                sala.puntosRondaEquipoB += 2;
            } else {
                sala.puntosRondaEquipoB += puntosRondaGanados;
            }
        }
    }
    
    // Notificar fin de mano
    const jugadoresArray = Array.from(sala.users.entries());
    io.to(salaId).emit("fin_mano", {
        puntosCartasA: puntosA,
        puntosCartasB: puntosB,
        cartasA: sala.cartasGanadasEquipoA,
        cartasB: sala.cartasGanadasEquipoB,
        ganadorRonda: ganadorRonda,
        puntosRondaA: sala.puntosRondaEquipoA,
        puntosRondaB: sala.puntosRondaEquipoB,
        mesaLimpia: mesaLimpia ? equipoMesaLimpia : null,
        puntosRondaGanados: puntosRondaGanados,
        bazasPorEquipo: sala.bazasGanadasPorEquipo || { A: 0, B: 0 }
    });
    
    io.to(salaId).emit("actualizar_puntos", {
        puntosRondaA: sala.puntosRondaEquipoA,
        puntosRondaB: sala.puntosRondaEquipoB,
        bazasMano: 0,
        nombresEquipoA: jugadoresArray.filter((_, i) => i % 2 === 0).map(([_, d]) => d.nombre),
        nombresEquipoB: jugadoresArray.filter((_, i) => i % 2 === 1).map(([_, d]) => d.nombre)
    });
    
    // Verificar ganador de partida
    if (sala.puntosRondaEquipoA >= 7) {
        sala.equipoGanador = 'A';
        io.to(salaId).emit("partida_ganada", {
            equipo: 'A',
            puntosA: sala.puntosRondaEquipoA,
            puntosB: sala.puntosRondaEquipoB,
            mesaLimpia: mesaLimpia ? equipoMesaLimpia : null,
            cantesA: sala.cantesTotales ? sala.cantesTotales.A : 0,
            cantesB: sala.cantesTotales ? sala.cantesTotales.B : 0,
            mensaje: `¡Equipo A gana la partida! ${sala.puntosRondaEquipoA} - ${sala.puntosRondaEquipoB}`
        });
        sala.juegoIniciado = false;
        sala.juegoActivo = false;
    } else if (sala.puntosRondaEquipoB >= 7) {
        sala.equipoGanador = 'B';
        io.to(salaId).emit("partida_ganada", {
            equipo: 'B',
            puntosA: sala.puntosRondaEquipoA,
            puntosB: sala.puntosRondaEquipoB,
            mesaLimpia: mesaLimpia ? equipoMesaLimpia : null,
            cantesA: sala.cantesTotales ? sala.cantesTotales.A : 0,
            cantesB: sala.cantesTotales ? sala.cantesTotales.B : 0,
            mensaje: `¡Equipo B gana la partida! ${sala.puntosRondaEquipoB} - ${sala.puntosRondaEquipoA}`
        });
        sala.juegoIniciado = false;
        sala.juegoActivo = false;
    } else {
        // Nueva mano
        console.log(`🔄 Iniciando nueva mano... Puntos: A=${sala.puntosRondaEquipoA}, B=${sala.puntosRondaEquipoB}`);
        setTimeout(() => {
            nuevaMano(sala);
        }, 3000);
    }
}

// Endpoint para obtener estado de salas
app.get('/', (req, res) => {
    const estadoSalas = [];
    salas.forEach((sala, id) => {
        estadoSalas.push({
            id: id,
            nombre: sala.nombre,
            jugadores: sala.users.size,
            maxJugadores: 4,
            juegoIniciado: sala.juegoIniciado
        });
    });
    res.json({ salas: estadoSalas });
});

io.on('connection', (socket) => {
    log('INFO', 'Socket connected', { socketId: socket.id, transport: socket.conn.transport.name });
    let salaActual = null;
    
    // Log de IP (útil para debugging)
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    log('DEBUG', 'Client IP', { socketId: socket.id, ip: clientIp });

    // Enviar estado actual de todas las salas al cliente recién conectado
    salas.forEach((sala, salaId) => {
        socket.emit("salas_actualizado", { salaId, contador: sala.users.size });
    });

    // Evento para unirse a una sala
    socket.on("unirse_sala", (numeroSala, nombre) => {
        const salaId = `sala${numeroSala}`;
        const sala = salas.get(salaId);
        log('INFO', 'unirse_sala', { socketId: socket.id, salaId, nombre });
        
        if (!sala) {
            socket.emit("error_sala", "Sala no existe");
            return;
        }
        
        if (sala.juegoIniciado) {
            socket.emit("error_sala", "El juego ya ha comenzado en esta sala");
            return;
        }
        
        if (sala.users.size >= 4) {
            socket.emit("error_sala", "Sala llena (máximo 4 jugadores)");
            return;
        }
        
        // Salir de sala anterior si existe
        if (salaActual) {
            socket.leave(salaActual);
            const salaAnterior = salas.get(salaActual);
            if (salaAnterior) {
                salaAnterior.users.delete(socket.id);
                socket.to(salaActual).emit("jugador_salio", socket.id);
            }
        }
        
        // Unirse a nueva sala
        salaActual = salaId;
        socket.join(salaId);
        log('INFO', 'Jugador unido a sala', { socketId: socket.id, salaId, nombre, totalJugadores: sala.users.size });
        
        let datos_usuario = {
            nombre: nombre,
            cartas: [],
            socketId: socket.id
        };
        
        sala.users.set(socket.id, datos_usuario);
        
        console.log(`${nombre} se unió a ${salaId}. Jugadores: ${sala.users.size}/4`);
        
        // Notificar a todos en la sala
        const usersArray = Array.from(sala.users);
        io.to(salaId).emit("actualizar_sala", {
            salaId: salaId,
            jugadores: usersArray,
            contador: sala.users.size
        });
        // Notificar a TODOS (incluidos los de otras salas) para actualizar el contador de jugadores
        io.emit("salas_actualizado", { salaId: salaId, contador: sala.users.size });
        
        // Confirmar al jugador que se unió
        socket.emit("sala_unida", { salaId: salaId, nombre: sala.nombre });
        
        // Si hay 4 jugadores, iniciar juego (con pequeño delay para asegurar que el cuarto jugador reciba todo)
        if (sala.users.size === 4) {
            setTimeout(() => iniciarJuego(sala), 500);
        }
    });
    
    // Evento para activar bots y completar la sala
    socket.on("activar_bots", (numeroSala) => {
        const salaId = `sala${numeroSala}`;
        const sala = salas.get(salaId);
        
        if (!sala) {
            socket.emit("error_sala", "Sala no existe");
            return;
        }
        
        if (sala.juegoIniciado) {
            socket.emit("error_sala", "El juego ya ha comenzado");
            return;
        }
        
        // Verificar que hay al menos 1 jugador real
        const jugadoresReales = contarJugadoresReales(sala);
        if (jugadoresReales === 0) {
            socket.emit("error_sala", "Debe haber al menos un jugador real");
            return;
        }
        
        // Calcular cuántos bots necesitamos
        const botsNecesarios = 4 - sala.users.size;
        if (botsNecesarios <= 0) {
            socket.emit("error_sala", "La sala ya está llena");
            return;
        }
        
        // Crear los bots necesarios
        for (let i = 0; i < botsNecesarios; i++) {
            crearBot(sala);
        }
        
        // Notificar a todos en la sala
        const usersArray = Array.from(sala.users);
        io.to(salaId).emit("actualizar_sala", {
            salaId: salaId,
            jugadores: usersArray,
            contador: sala.users.size,
            botsActivados: true,
            mensaje: `🤖 ${botsNecesarios} bot(s) añadido(s) a la sala`
        });
        
        io.emit("salas_actualizado", { salaId: salaId, contador: sala.users.size });
        
        socket.emit("bots_activados", {
            cantidad: botsNecesarios,
            totalJugadores: sala.users.size,
            mensaje: `${botsNecesarios} bot(s) añadido(s). ¡Listos para jugar!`
        });
        
        console.log(`🤖 Bots activados en ${salaId}: ${botsNecesarios} bots. Total: ${sala.users.size}/4`);
        
        // Si ahora hay 4 jugadores, iniciar juego
        if (sala.users.size === 4) {
            setTimeout(() => iniciarJuego(sala), 500);
        }
    });
    
    // Evento para quitar bots de una sala
    socket.on("quitar_bots", (numeroSala) => {
        const salaId = `sala${numeroSala}`;
        const sala = salas.get(salaId);
        
        if (!sala || sala.juegoIniciado) {
            socket.emit("error_sala", "No se pueden quitar bots ahora");
            return;
        }
        
        const botsAntes = sala.users.size - contarJugadoresReales(sala);
        eliminarBotsDeSala(sala);
        const botsDespues = sala.users.size - contarJugadoresReales(sala);
        const botsEliminados = botsAntes - botsDespues;
        
        if (botsEliminados > 0) {
            const usersArray = Array.from(sala.users);
            io.to(salaId).emit("actualizar_sala", {
                salaId: salaId,
                jugadores: usersArray,
                contador: sala.users.size,
                mensaje: `🤖 ${botsEliminados} bot(s) eliminado(s)`
            });
            io.emit("salas_actualizado", { salaId: salaId, contador: sala.users.size });
        }
        
        socket.emit("bots_desactivados", { cantidad: botsEliminados });
    });
    
    // Función para iniciar juego en una sala
    function iniciarJuego(sala) {
        console.log(`Iniciando juego en ${sala.id}`);
        sala.juegoIniciado = true;
        
        // Resetear puntuación de RONDAS (a 7)
        sala.puntosRondaEquipoA = 0;
        sala.puntosRondaEquipoB = 0;
        sala.equipoGanador = null;
        
        // Resetear mano actual
        sala.cartasGanadasEquipoA = [];
        sala.cartasGanadasEquipoB = [];
        sala.bazasJugadasMano = 0;
        sala.ganadorUltimaBaza = null;
        sala.bazasGanadasPorEquipo = { A: 0, B: 0 };
        
        let arrayCartitas = repartirCartas();
        let i = 0;
        
        // Guardar orden de jugadores para los turnos
        sala.ordenJugadores = Array.from(sala.users.keys());
        sala.turnoActual = 0;
        sala.manoIndex = 0;
        
        // Asignar equipos (0,2 = Equipo A; 1,3 = Equipo B)
        let index = 0;
        sala.users.forEach((valor, clave) => {
            valor.cartas = arrayCartitas[i];
            valor.equipo = index % 2 === 0 ? 'A' : 'B'; // 0,2 = A; 1,3 = B
            valor.numeroJugador = index;
            i++;
            index++;
        });
        
        sala.ultimaCarta = arrayCartitas[sala.manoIndex][4];
        const usersArray = Array.from(sala.users);
        
        // Determinar quién tiene el primer turno: el siguiente al que baraja (manoIndex)
        const primerTurnoIndex = (sala.manoIndex + 1) % 4;
        const primerTurno = sala.ordenJugadores[primerTurnoIndex];
        const primerJugador = sala.users.get(primerTurno);
        
        // Inicializar sistema de apuestas
        sala.faseApuestas = true;
        sala.apuestas = [];
        sala.apuestaActual = null;
        sala.historialApuestas = [];
        sala.turnoApuesta = null;
        sala.jugadoresPasaron = new Set();
        sala.cuatrolaActiva = null;
        sala.compañeroNoJuega = null;
        sala.palosCantados = { A: [], B: [] };
        sala.cantesTotales = { A: 0, B: 0 };
        
        // Enviar info de equipos
        const equiposInfo = {};
        sala.users.forEach((valor, clave) => {
            equiposInfo[clave] = { equipo: valor.equipo, numero: valor.numeroJugador };
        });
        
        // Iniciar con fase de apuestas
        const jugadoresArray = Array.from(sala.users.entries());
        const jugadoresInfo = jugadoresArray.map(([id, data], idx) => ({
            id,
            nombre: data.nombre,
            equipo: data.equipo,
            esMano: idx === 0
        }));
        
        // Enviar cartas a cada jugador ANTES de la fase de apuestas
        sala.users.forEach((valor, clave) => {
            io.to(clave).emit('mis_cartas_apuestas', {
                cartas: valor.cartas,
                ultimaCarta: sala.ultimaCarta,  // Fallo/triunfo para decidir apuesta
                mensaje: 'Tus cartas para decidir tu apuesta'
            });
        });
        
        // Jugador que tiene el fallo (quien baraja = manoIndex)
        const jugadorFalloInicio = sala.users.get(sala.ordenJugadores[sala.manoIndex]);
        sala.jugadorFalloNombre = jugadorFalloInicio ? jugadorFalloInicio.nombre : '';
        sala.turnoApuesta = primerTurno;
        
        io.to(sala.id).emit('fase_apuestas', {
            jugadores: jugadoresInfo,
            mano: { id: primerTurno, nombre: primerJugador ? primerJugador.nombre : '' },
            turnoApuesta: primerTurno,
            ordenApuestas: sala.ordenJugadores,
            mensaje: 'Fase de apuestas: Elige Solo (2pts), Cuatrola (4pts), Quintola (5pts), o Paso',
            puntosRondaA: sala.puntosRondaEquipoA,
            puntosRondaB: sala.puntosRondaEquipoB,
            jugadorFalloNombre: jugadorFalloInicio ? jugadorFalloInicio.nombre : '',
            jugadorFalloId: sala.ordenJugadores[sala.manoIndex]
        });
        
        // Si el primer jugador en apostar es un bot, hacer que apueste automáticamente
        const primerJugadorData = sala.users.get(primerTurno);
        if (primerJugadorData && primerJugadorData.esBot) {
            setTimeout(() => botRealizarApuesta(sala, primerTurno), 2000);
        }
        
        // Enviar info de compañeros (quién es compañero de quién)
        // Fórmula: (idx + 2) % 4 → 0↔2, 1↔3
        const companerosInfo = {};
        jugadoresArray.forEach(([id, datos], idx) => {
            const companeroIdx = (idx + 2) % 4;
            if (jugadoresArray[companeroIdx]) {
                companerosInfo[id] = {
                    companeroId: jugadoresArray[companeroIdx][0],
                    companeroNombre: jugadoresArray[companeroIdx][1].nombre,
                    miEquipo: datos.equipo,
                    miNumero: idx
                };
            }
        });
        io.to(sala.id).emit("companeros", companerosInfo);
        
        // Enviar puntuación inicial de RONDAS (a 7)
        io.to(sala.id).emit("actualizar_puntos", {
            puntosRondaA: 0,
            puntosRondaB: 0,
            bazasMano: 0,
            nombresEquipoA: jugadoresArray.filter((_,i) => i % 2 === 0).map(([_,d]) => d.nombre),
            nombresEquipoB: jugadoresArray.filter((_,i) => i % 2 === 1).map(([_,d]) => d.nombre)
        });
        
        const usersJSON = JSON.stringify(Array.from(sala.users.entries()));
        io.to(sala.id).emit('usuariosJSON', usersJSON);
    }
    
    // Función para obtener palo de una carta (usa la global)
    function getPalo(carta) {
        return carta.split('De')[1];
    }
    
    // Función para validar si una jugada es legal (usa la global)
    function validarJugada(sala, jugador, carta) {
        return validarJugadaGlobal(sala, jugador, carta);
    }
    
    // Evento para cantar (cuando un jugador tiene 11 y 12 del mismo palo)
    socket.on("cantar", (_jugadorIgnorado, datosCantar) => {
        const jugador = socket.id; // Siempre usar socket.id del servidor
        if (!salaActual) return;
        const sala = salas.get(salaActual);
        if (!sala) return;
        
        const jugadorData = sala.users.get(jugador);
        if (!jugadorData) return;

        // En cuatrola/quintola nadie puede cantar
        if (sala.cuatrolaActiva &&
            (sala.cuatrolaActiva.tipo === 'cuatrola' || sala.cuatrolaActiva.tipo === 'quintola')) {
            socket.emit("error_jugada", "No se puede cantar cuando hay Cuatrola o Quintola activa");
            return;
        }

        // Verificar que el jugador no sea el compañero que no juega (solo/cuatrola/quintola)
        if (sala.compañeroNoJuega === jugador) {
            socket.emit("error_jugada", "No puedes cantar si no juegas esta mano");
            return;
        }
        
        const equipo = jugadorData.equipo;
        const puntos = datosCantar.puntos;
        const palo = datosCantar.palo;
        
        // Verificar que realmente tiene 11 y 12 del palo
        const tiene11 = jugadorData.cartas.some(c => c === `11De${palo}`);
        const tiene12 = jugadorData.cartas.some(c => c === `12De${palo}`);
        
        if (!tiene11 || !tiene12) {
            socket.emit("error_jugada", "No tienes las cartas para cantar");
            return;
        }
        
        // Verificar que este palo no haya sido cantado ya por este equipo
        if (!sala.palosCantados) {
            sala.palosCantados = { A: [], B: [] };
        }
        
        if (sala.palosCantados[equipo].includes(palo)) {
            socket.emit("error_jugada", `Ya has cantado el palo ${palo} en esta mano`);
            return;
        }
        
        // Registrar palo como cantado
        sala.palosCantados[equipo].push(palo);
        if (!sala.cantesTotales) sala.cantesTotales = { A: 0, B: 0 };
        sala.cantesTotales[equipo]++;
        
        // Sumar puntos al equipo
        if (equipo === 'A') {
            sala.cartasGanadasEquipoA.push(`CANTO_${palo}_${puntos}`);
        } else {
            sala.cartasGanadasEquipoB.push(`CANTO_${palo}_${puntos}`);
        }
        
        // Notificar a todos
        io.to(salaActual).emit("jugador_canto", {
            jugador: jugadorData.nombre,
            equipo: equipo,
            palo: datosCantar.palo,
            puntos: puntos,
            esTriunfo: datosCantar.esTriunfo,
            mensaje: datosCantar.esTriunfo ? 
                `🎉 ${jugadorData.nombre} CANTA LAS 40 (${datosCantar.palo})!` : 
                `🎵 ${jugadorData.nombre} canta 20 (${datosCantar.palo})`
        });
        
        console.log(`${jugadorData.nombre} cantó ${puntos} puntos (${datosCantar.palo})`);

        // Calcular si le quedan más opciones de cante en esta baza
        const paloTriunfoAhora = sala.ultimaCarta ? sala.ultimaCarta.split('De')[1] : null;
        const opcionesRestantes = [];
        const palos = ['Bastos', 'Copas', 'Espadas', 'Oros'];
        for (const p of palos) {
            if (sala.palosCantados[equipo].includes(p)) continue;
            const tiene11 = jugadorData.cartas.some(c => c === `11De${p}`);
            const tiene12 = jugadorData.cartas.some(c => c === `12De${p}`);
            if (tiene11 && tiene12) {
                const esPaloTriunfo = paloTriunfoAhora && p === paloTriunfoAhora;
                opcionesRestantes.push({ palo: p, esTriunfo: esPaloTriunfo, puntos: esPaloTriunfo ? 40 : 20 });
            }
        }
        if (opcionesRestantes.length > 0) {
            socket.emit('cantar_opciones_restantes', {
                jugadorId: jugador,
                opciones: opcionesRestantes,
                palo: opcionesRestantes[0].palo,
                esTriunfo: opcionesRestantes[0].esTriunfo,
                puntos: opcionesRestantes[0].puntos
            });
        }
    });
    
    // Funciones auxiliares para apuestas
    // NOTA: iniciarJuegoNormal está ahora en scope global (línea 458)
    
    function iniciarJuegoConApuesta(sala, salaId) {
        const jugadoresArray = Array.from(sala.users.entries());
        const jugadoresInfo = jugadoresArray.map(([id, data]) => ({
            id, nombre: data.nombre, equipo: data.equipo, cartas: data.cartas,
            noJuega: id === sala.compañeroNoJuega
        }));
        
        // El que baraja (manoIndex) tiene el fallo pero NO empieza; empieza el siguiente activo
        let primerTurnoIndex = (sala.manoIndex + 1) % 4;
        if (sala.compañeroNoJuega && sala.ordenJugadores[primerTurnoIndex] === sala.compañeroNoJuega) {
            primerTurnoIndex = (primerTurnoIndex + 1) % 4;
        }
        const primerJugador = sala.users.get(sala.ordenJugadores[primerTurnoIndex]);
        const primerTurnoId = sala.ordenJugadores[primerTurnoIndex];
        
        // Construir equiposInfo correctamente (sala.users es un Map)
        const equiposInfo = {};
        sala.users.forEach((data, id) => {
            equiposInfo[id] = { equipo: data.equipo, numero: data.numeroJugador };
        });
        
        io.to(salaId).emit("start_game", 
            jugadoresInfo, 
            sala.ultimaCarta, 
            primerTurnoId,
            primerJugador ? primerJugador.nombre : '',
            equiposInfo
        );
        
        if (sala.cuatrolaActiva) {
            const noJuegaData = sala.users.get(sala.compañeroNoJuega);
            io.to(salaId).emit("cuatrola_anunciada", {
                apuesta: sala.cuatrolaActiva,
                compañeroNoJuega: noJuegaData ? noJuegaData.nombre : '',
                mensaje: `${sala.cuatrolaActiva.jugadorName} juega ${sala.cuatrolaActiva.tipo.toUpperCase()}. ${noJuegaData ? noJuegaData.nombre : ''} NO JUEGA esta mano.`
            });
        }
        sala.juegoActivo = true;
        sala.turnoActual = primerTurnoIndex;
        
        // Si el primer jugador es un bot, hacer que juegue automáticamente
        if (primerJugador && primerJugador.esBot) {
            console.log(`🤖 [ConApuesta] Primer jugador es bot: ${primerJugador.nombre}, cartas: ${primerJugador.cartas?.length || 0}`);
            setTimeout(() => botJugarCarta(sala, primerTurnoId), 2000);
        } else {
            console.log(`👤 [ConApuesta] Primer jugador es humano: ${primerJugador ? primerJugador.nombre : 'unknown'}`);
        }
    }
    
    // Evento para realizar apuesta
    socket.on("realizar_apuesta", (_jugadorIgnorado, tipoApuesta) => {
        const jugador = socket.id; // Siempre usar socket.id del servidor
        console.log(`💰 realizar_apuesta - jugador: ${jugador}, tipo: ${tipoApuesta}`);
        
        if (!salaActual) {
            console.log(`❌ realizar_apuesta: no hay salaActual`);
            return;
        }
        const sala = salas.get(salaActual);
        if (!sala) {
            console.log(`❌ realizar_apuesta: sala no encontrada`);
            return;
        }
        if (!sala.faseApuestas) {
            console.log(`❌ realizar_apuesta: no estamos en fase de apuestas. faseApuestas=${sala.faseApuestas}`);
            return;
        }
        
        const jugadorData = sala.users.get(jugador);
        if (!jugadorData) {
            console.log(`❌ realizar_apuesta: jugador ${jugador} no encontrado en sala`);
            return;
        }
        
        const totalRespuestas = sala.apuestas.length + sala.jugadoresPasaron.size;
        const turnoApuestaIdx = totalRespuestas % 4;
        const jugadorTurnoId = sala.ordenJugadores[(sala.manoIndex + 1 + turnoApuestaIdx) % 4];
        
        console.log(`🎯 realizar_apuesta - totalRespuestas: ${totalRespuestas}, manoIndex: ${sala.manoIndex}, turnoApuestaIdx: ${turnoApuestaIdx}, jugadorTurnoId: ${jugadorTurnoId}, jugador: ${jugador}`);
        
        if (jugador !== jugadorTurnoId) {
            console.log(`❌ realizar_apuesta: no es turno de ${jugador}, es turno de ${jugadorTurnoId}`);
            socket.emit("error_apuesta", "No es tu turno para apostar");
            return;
        }
        
        // Paso
        if (tipoApuesta === 'paso') {
            sala.jugadoresPasaron.add(jugador);
            const apuestaId = Date.now() + '_' + jugador;
            const apuestaObj = { id: apuestaId, jugador: jugadorData.nombre, tipo: 'paso', mensaje: `${jugadorData.nombre} PASA` };
            sala.historialApuestas = sala.historialApuestas || [];
            sala.historialApuestas.push(apuestaObj);
            io.to(salaActual).emit("apuesta_realizada", apuestaObj);
            
            if (sala.jugadoresPasaron.size === 4) {
                console.log(`✅ Todos los jugadores pasaron. Iniciando juego normal...`);
                sala.faseApuestas = false;
                iniciarJuegoNormal(sala, salaActual);
                return;
            }
            
            const siguienteIdx = (totalRespuestas + 1) % 4;
            const siguienteId = sala.ordenJugadores[(sala.manoIndex + 1 + siguienteIdx) % 4];
            const siguiente = sala.users.get(siguienteId);
            sala.turnoApuesta = siguienteId;
            io.to(salaActual).emit("turno_apuesta", {
                jugadorId: siguienteId, jugadorNombre: siguiente ? siguiente.nombre : '',
                apuestaActual: sala.apuestaActual, mensaje: `Turno de ${siguiente ? siguiente.nombre : ''}`
            });
            
            // Si el siguiente es un bot, hacer que apueste automáticamente
            if (siguiente && siguiente.esBot) {
                setTimeout(() => botRealizarApuesta(sala, siguienteId), 1500);
            }
            return;
        }
        
        const apuesta = {
            jugador: jugador, jugadorName: jugadorData.nombre,
            tipo: tipoApuesta, equipo: jugadorData.equipo,
            valor: tipoApuesta === 'solo' ? 2 : (tipoApuesta === 'cuatrola' ? 4 : 5)
        };
        sala.apuestas.push(apuesta);
        sala.apuestaActual = apuesta;
        
        // Solo, Cuatrola y Quintola: el compañero no juega, y la fase termina inmediatamente
        if (tipoApuesta === 'solo' || tipoApuesta === 'cuatrola' || tipoApuesta === 'quintola') {
            sala.cuatrolaActiva = apuesta;
            const idx = sala.ordenJugadores.indexOf(jugador);
            sala.compañeroNoJuega = sala.ordenJugadores[(idx + 2) % 4];
            sala.cuatrolaBazasGanadas = 0;
            
            const apuestaId = Date.now() + '_' + jugador;
            const apuestaObjEsp = { id: apuestaId, jugador: jugadorData.nombre, tipo: tipoApuesta, valor: apuesta.valor, mensaje: `${jugadorData.nombre} apuesta ${tipoApuesta.toUpperCase()} (${apuesta.valor} pts)` };
            sala.historialApuestas = sala.historialApuestas || [];
            sala.historialApuestas.push(apuestaObjEsp);
            io.to(salaActual).emit("apuesta_realizada", apuestaObjEsp);
            
            sala.faseApuestas = false;
            iniciarJuegoConApuesta(sala, salaActual);
            return;
        }
        
        const apuestaId = Date.now() + '_' + jugador;
        const apuestaObjNorm = { id: apuestaId, jugador: jugadorData.nombre, tipo: tipoApuesta, valor: apuesta.valor, mensaje: `${jugadorData.nombre} PASA` };
        sala.historialApuestas = sala.historialApuestas || [];
        sala.historialApuestas.push(apuestaObjNorm);
        io.to(salaActual).emit("apuesta_realizada", apuestaObjNorm);
        
        if (totalRespuestas + 1 >= 4) {
            sala.faseApuestas = false;
            iniciarJuegoConApuesta(sala, salaActual);
            return;
        }
        
        const siguienteIdx = (totalRespuestas + 1) % 4;
        const siguienteId = sala.ordenJugadores[(sala.manoIndex + 1 + siguienteIdx) % 4];
        const siguiente = sala.users.get(siguienteId);
        sala.turnoApuesta = siguienteId;
        io.to(salaActual).emit("turno_apuesta", {
            jugadorId: siguienteId, jugadorNombre: siguiente ? siguiente.nombre : '',
            apuestaActual: sala.apuestaActual, mensaje: `Turno de ${siguiente ? siguiente.nombre : ''}`
        });
        
        // Si el siguiente es un bot, hacer que apueste automáticamente
        if (siguiente && siguiente.esBot) {
            setTimeout(() => botRealizarApuesta(sala, siguienteId), 1500);
        }
    });
    
    // Evento para jugar carta
    socket.on("carta_seleccionada", (_jugadorIgnorado, carta) => {
        const jugador = socket.id; // Siempre usar socket.id del servidor, ignorar el del cliente
        console.log(`🎴 carta_seleccionada recibida - jugador: ${jugador}, carta: ${carta}`);
        
        if (!salaActual) {
            console.log(`❌ carta_seleccionada: no hay salaActual`);
            return;
        }
        const sala = salas.get(salaActual);
        if (!sala) {
            console.log(`❌ carta_seleccionada: sala no encontrada`);
            return;
        }
        
        console.log(`📊 Estado actual - cartasRonda: ${sala.cartasRonda.length}, turnoActual: ${sala.turnoActual}`);
        console.log(`📊 cartasRonda:`, sala.cartasRonda.map(j => ({jugador: j.jugador, carta: j.carta})));
        
        if (sala.faseApuestas) {
            console.log(`❌ carta_seleccionada: fase de apuestas activa`);
            socket.emit("error_jugada", "Fase de apuestas activa. Debes apostar o pasar.");
            return;
        }
        if (sala.compañeroNoJuega === jugador) {
            console.log(`❌ carta_seleccionada: compañero no juega`);
            socket.emit("error_jugada", "No juegas esta mano (tu compañero hizo Cuatrola/Quintola)");
            return;
        }
        
        // Verificar si es el turno del jugador
        const jugadorActualId = sala.ordenJugadores[sala.turnoActual];
        console.log(`👤 Turno actual: ${jugadorActualId}, Jugador que intenta: ${jugador}`);
        
        if (jugador !== jugadorActualId) {
            const turnoDe = sala.users.get(jugadorActualId);
            console.log(`❌ carta_seleccionada: no es turno de este jugador`);
            socket.emit("error_turno", `No es tu turno. Le toca a: ${turnoDe ? turnoDe.nombre : 'Otro jugador'}`);
            return;
        }
        
        // Verificar si ya jugó en esta ronda
        const jugadorYaJugo = sala.cartasRonda.some((jugada) => jugada.jugador === jugador);
        console.log(`🔍 jugadorYaJugo: ${jugadorYaJugo}`);
        
        if (jugadorYaJugo) {
            console.log(`❌ carta_seleccionada: jugador ${jugador} ya jugó en esta ronda`);
            socket.emit("error_jugada", "Ya jugaste una carta en esta ronda");
            return;
        }
        
        // Validar la jugada según reglas
        const validacion = validarJugada(sala, jugador, carta);
        if (!validacion.valida) {
            socket.emit("error_jugada", validacion.mensaje);
            return;
        }
        
        let jugada = { jugador: jugador, carta: carta };
        sala.cartasRonda.push(jugada);
        
        // Quitar carta del jugador
        let objetoModificar = Object.assign({}, sala.users.get(jugador));
        objetoModificar.cartas = objetoModificar.cartas.filter(cartaOriginal => cartaOriginal !== carta);
        sala.users.set(jugador, objetoModificar);
        
        // Emitir actualización de cartas a TODOS (igual que en botJugarCarta)
        const usersArray = Array.from(sala.users);
        io.to(salaActual).emit("quitar_carta_usuario", usersArray);
        
        sala.cartitasRonda.push(carta);
        io.to(salaActual).emit("mostrar_cartas_mesa", sala.cartitasRonda);
        
        // Avanzar turno (saltando compañero que no juega)
        sala.turnoActual = (sala.turnoActual + 1) % 4;
        while (sala.compañeroNoJuega && sala.ordenJugadores[sala.turnoActual] === sala.compañeroNoJuega) {
            sala.turnoActual = (sala.turnoActual + 1) % 4;
        }
        const siguienteTurnoId = sala.ordenJugadores[sala.turnoActual];
        const siguienteJugador = sala.users.get(siguienteTurnoId);
        
        const cartasNecesarias = sala.compañeroNoJuega ? 3 : 4;
        if (sala.cartasRonda.length === cartasNecesarias) {
            procesarFinBaza(sala, salaActual);
        } else {
            // Notificar cambio de turno solo cuando la baza NO está completa
            io.to(salaActual).emit("cambio_turno", siguienteTurnoId, siguienteJugador ? siguienteJugador.nombre : '');
            if (siguienteJugador && siguienteJugador.esBot) {
                setTimeout(() => botJugarCarta(sala, siguienteTurnoId), 1500);
            }
        }
    });
    
    // Evento para limpiar mesa
    socket.on("limpiar_mesa", () => {
        if (!salaActual) return;
        const sala = salas.get(salaActual);
        if (!sala) return;
        
        sala.todos_limpian++;
        if (sala.todos_limpian % 4 === 0) {
            io.to(salaActual).emit("vaciar_mesa");
        }
    });
    
    // Reconexión de jugador (vuelve tras perder conexión por pantalla apagada / cambio de app)
    socket.on("reconnect_player", ({ nombre, salaId }) => {
        log('INFO', 'Reconnect player attempt', { socketId: socket.id, nombre, salaId });
        const key = `${nombre}::${salaId}`;
        const guardado = jugadoresDesconectados.get(key);
        if (!guardado) {
            socket.emit("reconnect_failed", "No hay sesión guardada para reconectar");
            return;
        }
        
        // Cancelar el timeout de eliminación
        clearTimeout(guardado.timeout);
        jugadoresDesconectados.delete(key);
        
        const sala = salas.get(salaId);
        if (!sala) {
            socket.emit("reconnect_failed", "La sala ya no existe");
            return;
        }
        
        // Restaurar jugador con el nuevo socket ID
        const datosJugador = guardado.datos;
        datosJugador.socketId = socket.id; // Actualizar el campo socketId al nuevo id
        sala.users.set(socket.id, datosJugador);
        
        // Actualizar ordenJugadores sustituyendo el socket viejo por el nuevo
        const idxViejo = sala.ordenJugadores.indexOf(guardado.socketIdAnterior);
        if (idxViejo !== -1) sala.ordenJugadores[idxViejo] = socket.id;
        
        // Actualizar turnoActual si era el turno del jugador reconectado
        if (sala.turnoActual !== undefined && sala.ordenJugadores[sala.turnoActual] === socket.id) {
            // turnoActual ya apunta al nuevo id, ok
        }
        
        // Actualizar compañeroNoJuega si era ese jugador
        if (sala.compañeroNoJuega === guardado.socketIdAnterior) {
            sala.compañeroNoJuega = socket.id;
        }
        
        salaActual = salaId;
        socket.join(salaId);
        
        console.log(`♻️ ${datosJugador.nombre} reconectado en ${salaId} (nuevo id: ${socket.id})`);
        
        // Construir info completa de jugadores y equipos para el cliente
        const jugadoresArray = Array.from(sala.users.entries());
        const equiposInfo = {};
        const companerosInfo = {};
        sala.users.forEach((data, id) => {
            equiposInfo[id] = { equipo: data.equipo, numero: data.numeroJugador };
        });
        // Calcular compañeros (mismo equipo)
        sala.users.forEach((data, id) => {
            const companero = jugadoresArray.find(([cid, cdata]) => cid !== id && cdata.equipo === data.equipo);
            if (companero) {
                companerosInfo[id] = { companeroId: companero[0], nombre: companero[1].nombre };
            }
        });

        // Notificar al jugador reconectado su estado actual completo
        socket.emit("reconnected", {
            mensaje: `Bienvenido de vuelta, ${datosJugador.nombre}`,
            cartas: datosJugador.cartas,
            ultimaCarta: sala.ultimaCarta,
            turnoActual: sala.ordenJugadores[sala.turnoActual],
            faseApuestas: sala.faseApuestas,
            juegoActivo: sala.juegoActivo,
            cartasRonda: sala.cartasRonda || [],
            bazasMano: sala.bazasJugadasMano || 0,
            jugadores: jugadoresArray,
            equiposInfo,
            companerosInfo,
            miEquipo: datosJugador.equipo,
            puntosRondaA: sala.puntosRondaEquipoA || 0,
            puntosRondaB: sala.puntosRondaEquipoB || 0,
            nombresEquipoA: jugadoresArray.filter(([,d]) => d.equipo === 'A').map(([,d]) => d.nombre),
            nombresEquipoB: jugadoresArray.filter(([,d]) => d.equipo === 'B').map(([,d]) => d.nombre),
            compañeroNoJuega: sala.compañeroNoJuega,
            historialApuestas: sala.historialApuestas || [],
            apuestaActual: sala.apuestaActual || null,
            turnoApuesta: sala.turnoApuesta || null,
            jugadorFalloNombre: sala.jugadorFalloNombre || null
        });
        
        // Notificar al resto que el jugador volvió
        socket.to(salaId).emit("jugador_volvio", {
            nombre: datosJugador.nombre,
            mensaje: `${datosJugador.nombre} ha vuelto a la partida`
        });
    });

    // Salida voluntaria de sala (al terminar partida)
    socket.on("salir_sala", () => {
        log('INFO', 'salir_sala', { socketId: socket.id, salaActual });
        if (!salaActual) return;
        const sala = salas.get(salaActual);
        if (!sala) return;

        const jugador = sala.users.get(socket.id);
        const nombreJugador = jugador ? jugador.nombre : 'Jugador';

        sala.users.delete(socket.id);
        socket.leave(salaActual);

        io.emit("salas_actualizado", { salaId: salaActual, contador: sala.users.size });
        console.log(`🚪 ${nombreJugador} salió de ${salaActual}. Quedan: ${sala.users.size}`);

        if (sala.users.size === 0) {
            eliminarBotsDeSala(sala);
            sala.juegoIniciado = false;
            sala.juegoActivo = false;
            sala.cartasRonda = [];
            sala.cartitasRonda = [];
            sala.ultimaCarta = null;
            sala.todos_limpian = 0;
            sala.turnoActual = 0;
            sala.ordenJugadores = [];
            sala.puntosRondaEquipoA = 0;
            sala.puntosRondaEquipoB = 0;
            sala.equipoGanador = null;
            sala.cartasGanadasEquipoA = [];
            sala.cartasGanadasEquipoB = [];
            sala.bazasJugadasMano = 0;
            sala.ganadorUltimaBaza = null;
            sala.palosCantados = { A: [], B: [] };
            console.log(`🔄 Sala ${salaActual} reseteada completamente`);
        }

        salaActual = null;
    });

    // Evento para saltar la mano (solo super users)
    socket.on("skip_ronda", () => {
        if (!salaActual) {
            socket.emit("error_skip", "No estás en ninguna sala");
            return;
        }
        const sala = salas.get(salaActual);
        if (!sala) return;
        
        if (!esSuperUser(socket.id, sala)) {
            socket.emit("error_skip", "No tienes permisos para usar skip");
            return;
        }
        
        if (!sala.juegoActivo && !sala.juegoIniciado) {
            socket.emit("error_skip", "No hay juego activo");
            return;
        }
        
        const exito = skipMano(sala, salaActual, socket.id);
        if (exito) {
            socket.emit("skip_confirmado", { mensaje: "Skip ejecutado correctamente" });
        }
    });

    // Desconexión
    socket.on("disconnect", (reason) => {
        log('INFO', 'Socket disconnected', { socketId: socket.id, reason, salaActual });
        if (salaActual) {
            const sala = salas.get(salaActual);
            if (sala) {
                const jugadorDesconectado = sala.users.get(socket.id);
                const nombreJugador = jugadorDesconectado ? jugadorDesconectado.nombre : 'Jugador';
                
                // Grace period solo si el juego está en marcha con 4 jugadores (no en sala de espera)
                if (sala.juegoIniciado && sala.users.size === 4 && jugadorDesconectado) {
                    const key = `${nombreJugador}::${salaActual}`;
                    const timeoutId = setTimeout(() => {
                        // Grace period expirado: eliminar jugador definitivamente
                        jugadoresDesconectados.delete(key);
                        const salaAun = salas.get(salaActual);
                        if (salaAun && salaAun.users.has(socket.id)) {
                            salaAun.users.delete(socket.id);
                            io.to(salaActual).emit("jugador_abandono", {
                                socketId: socket.id,
                                nombre: nombreJugador,
                                mensaje: `${nombreJugador} ha abandonado el juego`
                            });
                            io.emit("salas_actualizado", { salaId: salaActual, contador: salaAun.users.size });
                            eliminarBotsDeSala(salaAun);
                            if (salaAun.juegoIniciado && salaAun.users.size < 4) {
                                salaAun.juegoIniciado = false;
                                salaAun.cartasRonda = [];
                                salaAun.cartitasRonda = [];
                                salaAun.ultimaCarta = null;
                                salaAun.todos_limpian = 0;
                                salaAun.turnoActual = 0;
                                salaAun.ordenJugadores = [];
                                io.to(salaActual).emit("juego_terminado", "Un jugador abandonó. El juego ha terminado.");
                            }
                        }
                    }, 30000);
                    
                    jugadoresDesconectados.set(key, {
                        datos: jugadorDesconectado,
                        socketIdAnterior: socket.id,
                        salaId: salaActual,
                        timeout: timeoutId
                    });
                    
                    // Notificar al resto que está desconectado temporalmente
                    io.to(salaActual).emit("jugador_desconectado_temp", {
                        nombre: nombreJugador,
                        mensaje: `${nombreJugador} se desconectó. Esperando reconexión (30s)...`
                    });
                    console.log(`⏳ ${nombreJugador} desconectado temporalmente. Grace period 30s.`);
                    return;
                }
                
                sala.users.delete(socket.id);
                
                // Notificar a todos que alguien abandonó
                io.to(salaActual).emit("jugador_abandono", {
                    socketId: socket.id,
                    nombre: nombreJugador,
                    mensaje: `${nombreJugador} ha abandonado el juego`
                });
                
                // Notificar actualización de sala
                const usersArray = Array.from(sala.users);
                socket.to(salaActual).emit("actualizar_sala", {
                    salaId: salaActual,
                    jugadores: usersArray,
                    contador: sala.users.size
                });
                // Notificar a TODOS los clientes (pantalla de salas) el nuevo contador
                io.emit("salas_actualizado", { salaId: salaActual, contador: sala.users.size });
                
                // Si el juego estaba iniciado y quedan menos de 4, terminar juego
                eliminarBotsDeSala(sala);
                if (sala.juegoIniciado && sala.users.size < 4) {
                    sala.juegoIniciado = false;
                    sala.cartasRonda = [];
                    sala.cartitasRonda = [];
                    sala.ultimaCarta = null;
                    sala.todos_limpian = 0;
                    sala.turnoActual = 0;
                    sala.ordenJugadores = [];
                    io.to(salaActual).emit("juego_terminado", "Un jugador abandonó. El juego ha terminado.");
                }
                
                // Si la sala quedó vacía, reiniciar completamente
                if (sala.users.size === 0) {
                    eliminarBotsDeSala(sala);
                    sala.juegoIniciado = false;
                    sala.juegoActivo = false;
                    sala.cartasRonda = [];
                    sala.cartitasRonda = [];
                    sala.ultimaCarta = null;
                    sala.todos_limpian = 0;
                    sala.turnoActual = 0;
                    sala.ordenJugadores = [];
                    sala.puntosRondaEquipoA = 0;
                    sala.puntosRondaEquipoB = 0;
                    sala.equipoGanador = null;
                    sala.cartasGanadasEquipoA = [];
                    sala.cartasGanadasEquipoB = [];
                    sala.bazasJugadasMano = 0;
                    sala.ganadorUltimaBaza = null;
                    sala.palosCantados = { A: [], B: [] };
                }
            }
        }
    });
});

// ========== ENDPOINTS DE AUTENTICACIÓN ==========

// Registro
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    log('INFO', 'Register attempt', { username, email });
    
    if (!username || !email || !password) {
        log('WARN', 'Register failed - missing fields', { username, email });
        return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    const result = await register(username, email, password);

    if (result.success) {
        activeSessions.set(result.user.id, result.token);
        log('INFO', 'Register success', { userId: result.user.id, username });
        res.json(result);
    } else {
        log('WARN', 'Register failed', { username, error: result.error });
        res.status(400).json(result);
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    const { usernameOrEmail, password } = req.body;
    log('INFO', 'Login attempt', { usernameOrEmail });

    if (!usernameOrEmail || !password) {
        log('WARN', 'Login failed - missing fields', { usernameOrEmail });
        return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const result = await login(usernameOrEmail, password);

    if (result.success) {
        if (activeSessions.has(result.user.id)) {
            const storedToken = activeSessions.get(result.user.id);
            if (verifyToken(storedToken)) {
                log('WARN', 'Login rejected - session already active', { userId: result.user.id, usernameOrEmail });
                return res.status(409).json({ success: false, error: 'Ya existe una sesión activa para este usuario. Cierra la sesión anterior antes de iniciar una nueva.' });
            }
            activeSessions.delete(result.user.id);
        }
        activeSessions.set(result.user.id, result.token);
        log('INFO', 'Login success', { userId: result.user.id, username: result.user.username });
        res.json(result);
    } else {
        log('WARN', 'Login failed', { usernameOrEmail, error: result.error });
        res.status(401).json(result);
    }
});

// Logout
app.post('/api/auth/logout', authMiddleware, (req, res) => {
    log('INFO', 'Logout', { userId: req.userId });
    activeSessions.delete(req.userId);
    res.json({ success: true });
});

// Perfil (requiere autenticación)
app.get('/api/auth/profile', authMiddleware, async (req, res) => {
    const result = await getUserById(req.userId);
    if (result.success) {
        res.json(result);
    } else {
        res.status(401).json(result);
    }
});

// Actualizar estadísticas (requiere autenticación)
app.post('/api/stats/update', authMiddleware, async (req, res) => {
    const { gamesPlayed, gamesWon, handsWon, totalPoints, mesasLimpias, cantes } = req.body;

    const result = await updateStats(req.userId, {
        gamesPlayed: gamesPlayed || 0,
        gamesWon: gamesWon || 0,
        handsWon: handsWon || 0,
        totalPoints: totalPoints || 0,
        mesasLimpias: mesasLimpias || 0,
        cantes: cantes || 0
    });

    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// Resetear estadísticas propias
app.post('/api/stats/reset', authMiddleware, async (req, res) => {
    const result = await resetStats(req.userId);
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// Seleccionar skin activa (requiere autenticación)
app.post('/api/skins/select', authMiddleware, async (req, res) => {
    const { skinId } = req.body;
    if (!skinId) return res.status(400).json({ error: 'Falta skinId' });
    const result = await selectSkin(req.userId, skinId);
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
});

// Ranking (público)
app.get('/api/leaderboard', async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const result = await getLeaderboard(limit);
    res.json(result);
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Admin - Estado del servidor (útil para debugging en Render)
app.get('/api/admin/status', (req, res) => {
    const salasEstado = {};
    salas.forEach((sala, id) => {
        salasEstado[id] = {
            jugadores: sala.users.size,
            juegoIniciado: sala.juegoIniciado,
            puntosA: sala.puntosRondaEquipoA,
            puntosB: sala.puntosRondaEquipoB
        };
    });
    
    res.json({
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        activeSessions: activeSessions.size,
        jugadoresDesconectados: jugadoresDesconectados.size,
        botsActivos: botsActivos.size,
        salas: salasEstado
    });
});

// Keep-alive para evitar que Render reinicie por inactividad
setInterval(() => {
    log('DEBUG', 'Keep-alive ping', { 
        uptime: process.uptime(), 
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        activeSessions: activeSessions.size,
        jugadoresDesconectados: jugadoresDesconectados.size,
        botsActivos: botsActivos.size
    });
}, 60000); // Cada 60 segundos

// Auto-ping HTTP para mantener Render despierto (WebSockets no cuentan como tráfico HTTP)
// Solo en producción y cada 10 minutos para evitar que el servicio se duerma
if (process.env.NODE_ENV === 'production') {
    const selfPingUrl = new URL(process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`);
    setInterval(() => {
        const options = {
            hostname: selfPingUrl.hostname,
            port: selfPingUrl.port || (selfPingUrl.protocol === 'https:' ? 443 : 80),
            path: '/api/health',
            method: 'GET',
            timeout: 5000
        };
        
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    log('DEBUG', 'Self-ping HTTP successful', { status: res.statusCode, timestamp: json.timestamp });
                } catch (e) {
                    log('DEBUG', 'Self-ping HTTP response', { status: res.statusCode });
                }
            });
        });
        
        req.on('error', (err) => {
            log('WARN', 'Self-ping HTTP failed', { error: err.message });
        });
        
        req.on('timeout', () => {
            req.destroy();
            log('WARN', 'Self-ping HTTP timeout');
        });
        
        req.end();
    }, 600000); // Cada 10 minutos
    log('INFO', 'Self-ping HTTP started', { url: selfPingUrl.toString(), interval: '10min' });
}

// Manejo de errores global para evitar crashes
process.on('uncaughtException', (err) => {
    log('ERROR', 'Uncaught Exception', { message: err.message, stack: err.stack });
    // No salir del proceso, solo loggear
});

process.on('unhandledRejection', (reason, promise) => {
    log('ERROR', 'Unhandled Rejection', { reason: reason?.toString(), promise: promise.toString() });
    // No salir del proceso
});

process.on('SIGTERM', () => {
    log('INFO', 'SIGTERM received, shutting down gracefully');
    server.close(() => {
        log('INFO', 'Server closed');
        process.exit(0);
    });
});

server.listen(PORT, async () => {
    log('INFO', 'Server started', { port: PORT, env: process.env.NODE_ENV || 'development', pid: process.pid });
    
    // Limpiar timeouts viejos de jugadores desconectados (por si el servidor crasheó)
    const staleCount = jugadoresDesconectados.size;
    jugadoresDesconectados.forEach((data, key) => {
        if (data.timeout) clearTimeout(data.timeout);
    });
    jugadoresDesconectados.clear();
    log('INFO', 'Cleared stale disconnections', { cleared: staleCount });
    
    // Resetear todas las salas al reiniciar (evitar estados inconsistentes)
    salas.forEach((sala, id) => {
        sala.juegoIniciado = false;
        sala.juegoActivo = false;
        sala.users.clear();
        sala.cartasRonda = [];
        sala.cartitasRonda = [];
        sala.ultimaCarta = null;
        sala.turnoActual = 0;
        sala.ordenJugadores = [];
        sala.puntosRondaEquipoA = 0;
        sala.puntosRondaEquipoB = 0;
        sala.equipoGanador = null;
        sala.bazasJugadasMano = 0;
        sala.ganadorUltimaBaza = null;
        sala.palosCantados = { A: [], B: [] };
    });
    log('INFO', 'Reset all game rooms');
    
    log('INFO', 'Active sessions tracking', { sessionsCount: activeSessions.size });
    await ensureDefaultUsers();
    log('INFO', 'Default users ensured');
});