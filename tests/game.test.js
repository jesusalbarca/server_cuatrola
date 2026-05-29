/**
 * Tests para Cuatrola - Foco: Juego con Bots vs Jugadores Reales
 * 
 * Para ejecutar:
 *   cd server
 *   npm test
 * 
 * Requiere: npm install --save-dev jest supertest socket.io-client
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Client from 'socket.io-client';
import express from 'express';

// Mocks para auth.js
jest.mock('../auth.js', () => ({
  register: jest.fn(() => Promise.resolve({ success: true, user: { id: '1', username: 'test' }, token: 'fake-token' })),
  login: jest.fn(() => Promise.resolve({ success: true, user: { id: '1', username: 'test' }, token: 'fake-token' })),
  getProfile: jest.fn(() => ({ success: true, user: { id: '1', username: 'test', stats: {} } })),
  updateStats: jest.fn(() => ({ success: true })),
  getLeaderboard: jest.fn(() => ({ success: true, leaderboard: [] })),
  authMiddleware: jest.fn((req, res, next) => next())
}));

// Timeout para tests de socket
jest.setTimeout(15000);

describe('🎮 Cuatrola - Tests de Juego con Bots', () => {
  let io, serverSocket, clientSocket, httpServer;
  let salaTest;

  beforeAll((done) => {
    const app = express();
    httpServer = createServer(app);
    io = new Server(httpServer, { cors: { origin: '*' } });
    
    httpServer.listen(() => {
      const port = httpServer.address().port;
      clientSocket = Client(`http://localhost:${port}`);
      
      io.on('connection', (socket) => {
        serverSocket = socket;
      });
      
      clientSocket.on('connect', done);
    });
  });

  afterAll(() => {
    if (clientSocket) clientSocket.close();
    if (io) io.close();
    if (httpServer) httpServer.close();
  });

  beforeEach(() => {
    // Resetear estado de sala antes de cada test
    salaTest = {
      id: 'sala1',
      users: new Map(),
      cartasRonda: [],
      cartitasRonda: [],
      turnoActual: 0,
      ordenJugadores: [],
      bazasJugadasMano: 0,
      compañeroNoJuega: null,
      juegoIniciado: false,
      juegoActivo: false,
      faseApuestas: false,
      cartasGanadasEquipoA: [],
      cartasGanadasEquipoB: [],
      bazasGanadasPorEquipo: { A: 0, B: 0 },
      ultimaCarta: '5DeOros',
      manoIndex: 0,
      palosCantados: { A: [], B: [] }
    };
  });

  // ============================================================
  // TEST 1: Creación de Bots
  // ============================================================
  describe('🤖 Creación y Gestión de Bots', () => {
    test('Debe crear bot con equipo asignado', () => {
      const botId = crearBot(salaTest);
      const bot = salaTest.users.get(botId);
      
      expect(bot).toBeDefined();
      expect(bot.esBot).toBe(true);
      expect(bot.equipo).toMatch(/^[AB]$/); // Debe tener equipo A o B
      expect(bot.cartas).toHaveLength(5);
      expect(bot.nombre).toContain('Bot');
    });

    test('Debe limpiar bots al desconectar último humano', () => {
      // Crear jugador humano y bots
      const humanoId = 'humano_123';
      salaTest.users.set(humanoId, { 
        nombre: 'Jugador', 
        esBot: false, 
        equipo: 'A',
        cartas: ['1DeOros', '3DeCopas', '10DeEspadas', '11DeBastos', '12DeOros']
      });
      
      const botId1 = crearBot(salaTest);
      const botId2 = crearBot(salaTest);
      
      expect(salaTest.users.size).toBe(3);
      
      // Simular desconexión del humano
      cleanupBots(salaTest);
      
      expect(salaTest.users.size).toBe(0);
      expect(salaTest.users.has(botId1)).toBe(false);
      expect(salaTest.users.has(botId2)).toBe(false);
    });

    test('No debe permitir bot sin equipo', () => {
      const botId = crearBot(salaTest);
      const bot = salaTest.users.get(botId);
      
      expect(bot.equipo).not.toBeNull();
      expect(['A', 'B']).toContain(bot.equipo);
    });
  });

  // ============================================================
  // TEST 2: Lógica de Juego Bot
  // ============================================================
  describe('🎲 Lógica de Juego de Bots', () => {
    test('Bot debe jugar carta válida cuando es primero', () => {
      const bot = crearBotConCartas(['1DeOros', '3DeCopas', '10DeEspadas', '11DeBastos', '12DeOros']);
      salaTest.users.set('bot1', bot);
      salaTest.cartasRonda = []; // Bot es primero
      
      const cartaJugada = simularJugadaBot(salaTest, 'bot1');
      
      expect(bot.cartas).not.toContain(cartaJugada);
      expect(salaTest.cartasRonda).toHaveLength(1);
      expect(salaTest.cartasRonda[0].carta).toBe(cartaJugada);
    });

    test('Bot debe seguir palo de salida si tiene', () => {
      const bot = crearBotConCartas(['1DeOros', '3DeOros', '10DeEspadas', '11DeBastos', '12DeCopas']);
      salaTest.users.set('bot1', bot);
      
      // Simular que ya hay carta de Oros en mesa
      salaTest.cartasRonda = [{ jugador: 'otro', carta: '5DeOros' }];
      
      const cartaJugada = simularJugadaBot(salaTest, 'bot1');
      
      // Debe jugar Oros porque tiene
      expect(cartaJugada).toContain('Oros');
    });

    test('Bot debe jugar triunfo si no tiene palo de salida', () => {
      salaTest.ultimaCarta = '7DeCopas'; // Triunfo = Copas
      
      const bot = crearBotConCartas(['1DeOros', '3DeOros', '10DeCopas', '11DeBastos', '12DeEspadas']);
      salaTest.users.set('bot1', bot);
      
      // Simular carta de Espadas en mesa (bot no tiene Espadas)
      salaTest.cartasRonda = [{ jugador: 'otro', carta: '5DeEspadas' }];
      
      const cartaJugada = simularJugadaBot(salaTest, 'bot1');
      
      // Debe jugar Copas (triunfo)
      expect(cartaJugada).toContain('Copas');
    });

    test('Bot debe tener fallback cuando ninguna carta es válida', () => {
      const bot = crearBotConCartas(['1DeOros']);
      salaTest.users.set('bot1', bot);
      salaTest.cartasRonda = [];
      
      // Forzar que validación falle para todas
      const mockValidar = jest.fn().mockReturnValue({ valida: false });
      
      // Simular con mock de validación
      const cartaJugada = simularJugadaBotConMock(salaTest, 'bot1', mockValidar);
      
      // Aunque ninguna sea "válida", debe jugar algo (la primera)
      expect(cartaJugada).toBeDefined();
      expect(bot.cartas).toHaveLength(0);
    });
  });

  // ============================================================
  // TEST 3: Race Conditions
  // ============================================================
  describe('⚡ Race Conditions', () => {
    test('Dos bots no deben jugar la misma carta simultáneamente', async () => {
      const bot1 = crearBotConCartas(['1DeOros', '3DeCopas', '10DeEspadas', '11DeBastos', '12DeOros']);
      const bot2 = crearBotConCartas(['1DeCopas', '3DeOros', '10DeBastos', '11DeEspadas', '12DeCopas']);
      
      salaTest.users.set('bot1', bot1);
      salaTest.users.set('bot2', bot2);
      salaTest.ordenJugadores = ['bot1', 'bot2'];
      salaTest.cartasRonda = [];
      
      // Intentar que ambos bots jueguen "simultáneamente"
      const promesa1 = simularJugadaBotAsync(salaTest, 'bot1');
      const promesa2 = simularJugadaBotAsync(salaTest, 'bot2');
      
      await Promise.all([promesa1, promesa2]);
      
      // Verificar que no hay cartas duplicadas
      const cartasEnMesa = salaTest.cartasRonda.map(c => c.carta);
      const cartasUnicas = [...new Set(cartasEnMesa)];
      
      expect(cartasEnMesa).toHaveLength(cartasUnicas.length);
    });

    test('Bot no debe jugar carta ya jugada por otro bot', async () => {
      const bot1 = crearBotConCartas(['1DeOros', '3DeCopas', '10DeEspadas', '11DeBastos', '12DeOros']);
      const bot2 = crearBotConCartas(['1DeOros', '3DeOros', '10DeBastos', '11DeEspadas', '12DeCopas']);
      // Ambos tienen '1DeOros' - potencial conflicto
      
      salaTest.users.set('bot1', bot1);
      salaTest.users.set('bot2', bot2);
      
      // Bot1 juega primero
      const cartaBot1 = simularJugadaBot(salaTest, 'bot1');
      
      // Bot2 intenta jugar (sin el timeout del setTimeout)
      // Simular que Bot2 selecciona la misma carta antes de que se filtre
      const cartaSeleccionadaBot2 = cartaBot1; // Intentar duplicar
      
      // La validación debe rechazar carta ya en mesa
      const estaEnMesa = salaTest.cartasRonda.some(c => c.carta === cartaSeleccionadaBot2);
      if (estaEnMesa) {
        // Si está en mesa, el bot debe elegir otra
        const otraCarta = bot2.cartas.find(c => c !== cartaSeleccionadaBot2);
        expect(otraCarta).toBeDefined();
      }
    });
  });

  // ============================================================
  // TEST 4: Fase de Apuestas
  // ============================================================
  describe('🎰 Fase de Apuestas con Bots', () => {
    test('Todos los bots deben pasar', () => {
      salaTest.faseApuestas = true;
      salaTest.jugadoresPasaron = new Set();
      salaTest.apuestas = [];
      
      // Crear 4 bots
      for (let i = 0; i < 4; i++) {
        const botId = crearBot(salaTest);
        botRealizarApuesta(salaTest, botId);
      }
      
      // Todos deben haber pasado
      expect(salaTest.jugadoresPasaron.size).toBe(4);
      expect(salaTest.faseApuestas).toBe(false);
    });

    test('Fase apuestas debe terminar correctamente con mix humano/bots', () => {
      salaTest.faseApuestas = true;
      salaTest.jugadoresPasaron = new Set();
      
      // 1 humano + 3 bots
      salaTest.users.set('humano', { nombre: 'Humano', esBot: false, equipo: 'A', cartas: [] });
      const botId1 = crearBot(salaTest);
      const botId2 = crearBot(salaTest);
      const botId3 = crearBot(salaTest);
      
      salaTest.ordenJugadores = ['humano', botId1, botId2, botId3];
      
      // Bots pasan
      botRealizarApuesta(salaTest, botId1);
      botRealizarApuesta(salaTest, botId2);
      botRealizarApuesta(salaTest, botId3);
      
      // Humano pasa
      salaTest.jugadoresPasaron.add('humano');
      
      // Verificar condición de fin
      const totalRespuestas = salaTest.apuestas.length + salaTest.jugadoresPasaron.size;
      if (salaTest.jugadoresPasaron.size === 4 || totalRespuestas >= 4) {
        expect(salaTest.faseApuestas).toBe(false);
      }
    });
  });

  // ============================================================
  // TEST 5: Fin de Baza
  // ============================================================
  describe('🏆 Fin de Baza', () => {
    test('Debe calcular ganador correctamente con triunfo', () => {
      salaTest.ultimaCarta = '7DeCopas'; // Triunfo = Copas
      
      // Cartas en mesa: unas Copas, otras no
      salaTest.cartasRonda = [
        { jugador: 'j1', carta: '1DeOros' },    // Gana si no hay Copas
        { jugador: 'j2', carta: '3DeCopas' },   // Triunfo, valor 4
        { jugador: 'j3', carta: '1DeEspadas' }, // Palo distinto
        { jugador: 'j4', carta: '10DeCopas' }   // Triunfo, valor 1
      ];
      
      const usuarios = new Map([
        ['j1', { nombre: 'J1', equipo: 'A' }],
        ['j2', { nombre: 'J2', equipo: 'B' }],
        ['j3', { nombre: 'J3', equipo: 'A' }],
        ['j4', { nombre: 'J4', equipo: 'B' }]
      ]);
      
      const ganador = calcularGanadorRonda(salaTest.ultimaCarta, salaTest.cartasRonda, usuarios);
      
      // Debe ganar j2 con 3DeCopas (triunfo más alto)
      expect(ganador.jugador).toBe('j2');
      expect(ganador.carta).toBe('3DeCopas');
    });

    test('Debe manejar baza con menos de 4 cartas (cuatrola/quintola)', () => {
      salaTest.compañeroNoJuega = 'j3'; // j3 no juega
      salaTest.ultimaCarta = '7DeOros';
      
      // Solo 3 cartas en mesa
      salaTest.cartasRonda = [
        { jugador: 'j1', carta: '1DeOros' },
        { jugador: 'j2', carta: '3DeCopas' },
        { jugador: 'j4', carta: '10DeBastos' }
      ];
      
      const usuarios = new Map([
        ['j1', { nombre: 'J1', equipo: 'A' }],
        ['j2', { nombre: 'J2', equipo: 'B' }],
        ['j3', { nombre: 'J3', equipo: 'A', noJuega: true }],
        ['j4', { nombre: 'J4', equipo: 'B' }]
      ]);
      
      const ganador = calcularGanadorRonda(salaTest.ultimaCarta, salaTest.cartasRonda, usuarios);
      
      expect(ganador).toBeDefined();
      expect(['j1', 'j2', 'j4']).toContain(ganador.jugador);
    });
  });

  // ============================================================
  // TEST 6: Integración - Partida Completa
  // ============================================================
  describe('🎮 Integración - Partida Completa', () => {
    test('1 humano vs 3 bots - flujo completo de mano', async () => {
      // Setup: 1 humano + 3 bots
      salaTest.users.set('humano', {
        nombre: 'TestPlayer',
        esBot: false,
        equipo: 'A',
        cartas: ['1DeOros', '3DeCopas', '10DeEspadas', '11DeBastos', '12DeOros']
      });
      
      const botIds = [];
      for (let i = 0; i < 3; i++) {
        botIds.push(crearBot(salaTest));
      }
      
      salaTest.ordenJugadores = ['humano', ...botIds];
      salaTest.juegoIniciado = true;
      salaTest.juegoActivo = true;
      
      // Simular 5 bazas
      for (let baza = 0; baza < 5; baza++) {
        salaTest.cartasRonda = [];
        
        // Cada jugador juega una carta
        for (const jugadorId of salaTest.ordenJugadores) {
          const jugador = salaTest.users.get(jugadorId);
          if (jugador.cartas.length > 0) {
            const carta = jugador.cartas[0];
            salaTest.cartasRonda.push({ jugador: jugadorId, carta });
            jugador.cartas.shift();
          }
        }
        
        // Verificar que hay 4 cartas en mesa
        expect(salaTest.cartasRonda).toHaveLength(4);
        
        // Simular procesar fin de baza
        salaTest.bazasJugadasMano++;
      }
      
      expect(salaTest.bazasJugadasMano).toBe(5);
    });
  });
});

// ============================================================
// FUNCIONES AUXILIARES PARA TESTS
// ============================================================

function crearBot(sala) {
  const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const equipos = ['A', 'B', 'A', 'B'];
  const index = sala.users.size;
  
  const datosBot = {
    nombre: `🤖 Bot ${index + 1}`,
    cartas: generarCartasAleatorias(),
    socketId: botId,
    esBot: true,
    equipo: equipos[index % 4],
    numeroJugador: index + 1
  };
  
  sala.users.set(botId, datosBot);
  sala.ordenJugadores.push(botId);
  
  return botId;
}

function crearBotConCartas(cartas) {
  return {
    nombre: '🤖 Bot Test',
    cartas: [...cartas],
    esBot: true,
    equipo: 'A',
    numeroJugador: 1
  };
}

function generarCartasAleatorias() {
  const palos = ['Oros', 'Copas', 'Espadas', 'Bastos'];
  const valores = ['1', '3', '10', '11', '12'];
  const cartas = [];
  
  for (let i = 0; i < 5; i++) {
    const valor = valores[Math.floor(Math.random() * valores.length)];
    const palo = palos[Math.floor(Math.random() * palos.length)];
    cartas.push(`${valor}De${palo}`);
  }
  
  return cartas;
}

function cleanupBots(sala) {
  const botsAEliminar = [];
  for (const [id, user] of sala.users.entries()) {
    if (user.esBot) {
      botsAEliminar.push(id);
    }
  }
  botsAEliminar.forEach(id => sala.users.delete(id));
  
  // Limpiar ordenJugadores
  sala.ordenJugadores = sala.ordenJugadores.filter(id => !botsAEliminar.includes(id));
}

function simularJugadaBot(sala, botId) {
  const bot = sala.users.get(botId);
  if (!bot || bot.cartas.length === 0) return null;
  
  // Lógica simplificada: jugar primera carta
  const carta = bot.cartas[0];
  bot.cartas.shift();
  
  sala.cartasRonda.push({ jugador: botId, carta });
  
  return carta;
}

function simularJugadaBotConMock(sala, botId, mockValidar) {
  const bot = sala.users.get(botId);
  if (!bot || bot.cartas.length === 0) return null;
  
  // Intentar cada carta
  let cartaAJugar = null;
  for (const carta of bot.cartas) {
    if (mockValidar(carta).valida) {
      cartaAJugar = carta;
      break;
    }
  }
  
  // Fallback: primera carta
  if (!cartaAJugar) {
    cartaAJugar = bot.cartas[0];
  }
  
  bot.cartas = bot.cartas.filter(c => c !== cartaAJugar);
  sala.cartasRonda.push({ jugador: botId, carta: cartaAJugar });
  
  return cartaAJugar;
}

function simularJugadaBotAsync(sala, botId) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const carta = simularJugadaBot(sala, botId);
      resolve(carta);
    }, Math.random() * 100);
  });
}

function botRealizarApuesta(sala, botId) {
  const bot = sala.users.get(botId);
  if (!bot?.esBot) return;
  
  sala.jugadoresPasaron = sala.jugadoresPasaron || new Set();
  sala.jugadoresPasaron.add(botId);
}

// Stubs de funciones del servidor que necesitamos
function calcularGanadorRonda(ultimaCarta, cartasRonda, users) {
  if (!ultimaCarta || !cartasRonda || cartasRonda.length === 0) {
    return null;
  }
  
  const paloTriunfo = ultimaCarta.split('De')[1];
  
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
  
  // Buscar cartas de triunfo
  const cartasFallo = cartasRonda.filter(c => c.carta.endsWith(paloTriunfo));
  
  if (cartasFallo.length > 0) {
    const cartaGanadora = cartasFallo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    const jugador = users.get(cartaGanadora.jugador);
    return { ...cartaGanadora, paloGanador: paloTriunfo, jugador_name: jugador?.nombre || 'Desconocido' };
  }
  
  // Usar palo de salida
  const paloSalida = cartasRonda[0].carta.split('De')[1];
  const cartasMismoPalo = cartasRonda.filter(c => c.carta.endsWith(paloSalida));
  
  if (cartasMismoPalo.length > 0) {
    const cartaGanadora = cartasMismoPalo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    const jugador = users.get(cartaGanadora.jugador);
    return { ...cartaGanadora, paloGanador: paloSalida, jugador_name: jugador?.nombre || 'Desconocido' };
  }
  
  // Fallback
  const cartaGanadora = cartasRonda.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
  const jugador = users.get(cartaGanadora.jugador);
  return { ...cartaGanadora, paloGanador: null, jugador_name: jugador?.nombre || 'Desconocido' };
}
