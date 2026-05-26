import express from "express";
import { Server as SocketServer } from "socket.io";
import http from 'http'
import cors from 'cors'

const PORT = process.env.PORT || 4000

const app = express();
const server = http.createServer(app)
const io = new SocketServer(server, {
    cors:{
        origin: '*'
    }
})

app.use(cors())

// Cartas disponibles para el juego
const cartasDisponibles = ['1DeOros', '3DeOros', '10DeOros', '11DeOros', '12DeOros',
                           '1DeCopas', '3DeCopas', '10DeCopas', '11DeCopas', '12DeCopas',
                           '1DeEspadas', '3DeEspadas', '10DeEspadas', '11DeEspadas', '12DeEspadas',
                           '1DeBastos', '3DeBastos', '10DeBastos', '11DeBastos', '12DeBastos'];

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

// Función para calcular ganador de ronda
function calcularGanadorRonda(ultimaCarta, cartasRonda, users) {
  const cartasFallo = cartasRonda.filter((carta) => carta.carta.endsWith(ultimaCarta.split('De')[1]));
  if (cartasFallo.length > 0) {
    const cartaGanadora = cartasFallo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    const jugador = users.get(cartaGanadora.jugador);
    return { ...cartaGanadora, paloGanador: ultimaCarta.split('De')[1], jugador_name: jugador ? jugador.nombre : 'Desconocido' };
  }
  const paloFallo = ultimaCarta.split('De')[1];
  const cartasMismoPalo = cartasRonda.filter((carta) => carta.carta.endsWith(paloFallo));
  if (cartasMismoPalo.length > 0) {
    const cartaGanadora = cartasMismoPalo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    const jugador = users.get(cartaGanadora.jugador);
    return { ...cartaGanadora, paloGanador: paloFallo, jugador_name: jugador ? jugador.nombre : 'Desconocido' };
  }
  const cartaGanadora = cartasRonda.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
  const jugador = users.get(cartaGanadora.jugador);
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
    console.log("Nuevo cliente: " + socket.id);
    let salaActual = null;

    // Evento para unirse a una sala
    socket.on("unirse_sala", (numeroSala, nombre) => {
        const salaId = `sala${numeroSala}`;
        const sala = salas.get(salaId);
        
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
        
        // Confirmar al jugador que se unió
        socket.emit("sala_unida", { salaId: salaId, nombre: sala.nombre });
        
        // Si hay 4 jugadores, iniciar juego (con pequeño delay para asegurar que el cuarto jugador reciba todo)
        if (sala.users.size === 4) {
            setTimeout(() => iniciarJuego(sala), 500);
        }
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
        
        let arrayCartitas = repartirCartas();
        let i = 0;
        
        // Guardar orden de jugadores para los turnos
        sala.ordenJugadores = Array.from(sala.users.keys());
        sala.turnoActual = 0;
        
        // Asignar equipos (0,2 = Equipo A; 1,3 = Equipo B)
        let index = 0;
        sala.users.forEach((valor, clave) => {
            valor.cartas = arrayCartitas[i];
            valor.equipo = index % 2 === 0 ? 'A' : 'B'; // 0,2 = A; 1,3 = B
            valor.numeroJugador = index;
            i++;
            index++;
        });
        
        sala.ultimaCarta = arrayCartitas[3][4];
        const usersArray = Array.from(sala.users);
        
        // Determinar quién tiene el primer turno (el primero en el orden)
        const primerTurno = sala.ordenJugadores[0];
        const primerJugador = sala.users.get(primerTurno);
        
        // Inicializar sistema de apuestas
        sala.faseApuestas = true;
        sala.apuestas = [];
        sala.apuestaActual = null;
        sala.jugadoresPasaron = new Set();
        sala.cuatrolaActiva = null;
        sala.compañeroNoJuega = null;
        sala.manoIndex = 0;
        
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
                mensaje: 'Tus cartas para decidir tu apuesta'
            });
        });
        
        io.to(sala.id).emit('fase_apuestas', {
            jugadores: jugadoresInfo,
            mano: { id: primerTurno, nombre: primerJugador ? primerJugador.nombre : '' },
            turnoApuesta: primerTurno,
            ordenApuestas: sala.ordenJugadores,
            mensaje: 'Fase de apuestas: Elige Solo (2pts), Cuatrola (4pts), Quintola (5pts), o Paso'
        });
        
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
    
    // Función para obtener palo de una carta
    function getPalo(carta) {
        return carta.split('De')[1];
    }
    
    // Función para validar si una jugada es legal
    function validarJugada(sala, jugador, carta) {
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
                    // Sí supera, jugada válida
                    return { valida: true };
                } else if (puedoSuperar) {
                    // Tiene cartas que superan pero no está jugando una de ellas
                    return {
                        valida: false,
                        mensaje: `Debes asistir superando: tienes cartas del palo ${paloSalida} que superan la mesa.`
                    };
                }
            }
            // No hay cartas del palo en mesa o no puede superar
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
            // Está jugando triunfo - verificar si debe superar
            if (hayTriunfoEnMesa) {
                const mayorTriunfoEnMesa = Math.max(...cartasTriunfoEnMesa.map(j => valorCarta(j.carta)));
                const valorMiTriunfo = valorCarta(carta);
                const misTriunfos = cartasJugador.filter(c => getPalo(c) === paloTriunfo).map(c => valorCarta(c));
                const puedoSuperar = misTriunfos.some(v => v > mayorTriunfoEnMesa);
                
                if (valorMiTriunfo > mayorTriunfoEnMesa) {
                    // Sí supera, jugada válida
                    return { valida: true, esFallo: true };
                } else if (puedoSuperar) {
                    // Tiene triunfos que superan pero no está jugando uno de ellos
                    return {
                        valida: false,
                        mensaje: `Debes fallar superando: tienes triunfos que superan el ${mayorTriunfoEnMesa} en mesa.`
                    };
                } else {
                    // No puede superar, cualquier triunfo es válido
                    return { valida: true, esFallo: true };
                }
            } else {
                // No hay triunfo en mesa, cualquier triunfo es válido
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
                    // Tiene triunfos que superan, debe fallar obligatoriamente
                    return {
                        valida: false,
                        mensaje: `Debes fallar superando: tienes triunfos (${paloTriunfo}) que superan el ${mayorTriunfoEnMesa} en mesa.`
                    };
                }
                // No puede superar el triunfo en mesa, no está obligado a fallar
                return { valida: true, esDescarte: true };
            } else {
                // No hay triunfo en mesa, debe fallar obligatoriamente
                return {
                    valida: false,
                    mensaje: `Debes fallar: tienes triunfos (${paloTriunfo}) y no hay triunfo en mesa.`
                };
            }
        }
        
        // No tiene palo de salida ni triunfos, puede jugar cualquier otra carta
        return { valida: true, esDescarte: true };
    }
    
    // Evento para cantar (cuando un jugador tiene 11 y 12 del mismo palo)
    socket.on("cantar", (jugador, datosCantar) => {
        if (!salaActual) return;
        const sala = salas.get(salaActual);
        if (!sala) return;
        
        const jugadorData = sala.users.get(jugador);
        if (!jugadorData) return;
        
        const equipo = jugadorData.equipo;
        const puntos = datosCantar.puntos;
        
        // Verificar que realmente tiene 11 y 12 del palo
        const tiene11 = jugadorData.cartas.some(c => c === `11De${datosCantar.palo}`);
        const tiene12 = jugadorData.cartas.some(c => c === `12De${datosCantar.palo}`);
        
        if (!tiene11 || !tiene12) {
            socket.emit("error_jugada", "No tienes las cartas para cantar");
            return;
        }
        
        // Sumar puntos al equipo
        if (equipo === 'A') {
            sala.cartasGanadasEquipoA.push(`CANTO_${datosCantar.palo}_${puntos}`);
        } else {
            sala.cartasGanadasEquipoB.push(`CANTO_${datosCantar.palo}_${puntos}`);
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
    });
    
    // Funciones auxiliares para apuestas
    function iniciarJuegoNormal(sala, salaId) {
        const jugadoresArray = Array.from(sala.users.entries());
        const jugadoresInfo = jugadoresArray.map(([id, data]) => ({
            id, nombre: data.nombre, equipo: data.equipo, cartas: data.cartas
        }));
        const primerJugador = sala.users.get(sala.ordenJugadores[0]);
        
        io.to(salaId).emit("start_game", 
            jugadoresInfo, 
            sala.ultimaCarta, 
            sala.ordenJugadores[0],
            primerJugador ? primerJugador.nombre : '',
            Object.fromEntries(sala.users.map(d => [d.id, {equipo: d.equipo, numero: d.numeroJugador}]))
        );
        sala.juegoActivo = true;
    }
    
    function iniciarJuegoConApuesta(sala, salaId) {
        const jugadoresArray = Array.from(sala.users.entries());
        const jugadoresInfo = jugadoresArray.map(([id, data]) => ({
            id, nombre: data.nombre, equipo: data.equipo, cartas: data.cartas,
            noJuega: id === sala.compañeroNoJuega
        }));
        const primerJugador = sala.users.get(sala.ordenJugadores[0]);
        
        io.to(salaId).emit("start_game", 
            jugadoresInfo, 
            sala.ultimaCarta, 
            sala.ordenJugadores[0],
            primerJugador ? primerJugador.nombre : '',
            Object.fromEntries(sala.users.map(d => [d.id, {equipo: d.equipo, numero: d.numeroJugador}]))
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
    }
    
    // Evento para realizar apuesta
    socket.on("realizar_apuesta", (jugador, tipoApuesta) => {
        if (!salaActual) return;
        const sala = salas.get(salaActual);
        if (!sala) return;
        if (!sala.faseApuestas) return;
        
        const jugadorData = sala.users.get(jugador);
        if (!jugadorData) return;
        
        const totalRespuestas = sala.apuestas.length + sala.jugadoresPasaron.size;
        const turnoApuestaIdx = totalRespuestas % 4;
        const jugadorTurnoId = sala.ordenJugadores[(sala.manoIndex + turnoApuestaIdx) % 4];
        
        if (jugador !== jugadorTurnoId) {
            socket.emit("error_apuesta", "No es tu turno para apostar");
            return;
        }
        
        // Paso
        if (tipoApuesta === 'paso') {
            sala.jugadoresPasaron.add(jugador);
            io.to(salaActual).emit("apuesta_realizada", {
                jugador: jugadorData.nombre, tipo: 'paso', mensaje: `${jugadorData.nombre} PASA`
            });
            
            if (sala.jugadoresPasaron.size === 4) {
                sala.faseApuestas = false;
                iniciarJuegoNormal(sala, salaActual);
                return;
            }
            
            const siguienteIdx = (totalRespuestas + 1) % 4;
            const siguienteId = sala.ordenJugadores[(sala.manoIndex + siguienteIdx) % 4];
            const siguiente = sala.users.get(siguienteId);
            io.to(salaActual).emit("turno_apuesta", {
                jugadorId: siguienteId, jugadorNombre: siguiente ? siguiente.nombre : '',
                apuestaActual: sala.apuestaActual, mensaje: `Turno de ${siguiente ? siguiente.nombre : ''}`
            });
            return;
        }
        
        // Validar apuesta (debe ser mayor)
        const valores = { 'solo': 1, 'cuatrola': 2, 'quintola': 3 };
        if (sala.apuestaActual && valores[tipoApuesta] <= valores[sala.apuestaActual.tipo]) {
            socket.emit("error_apuesta", `Debes superar: ${sala.apuestaActual.tipo}`);
            return;
        }
        
        const apuesta = {
            jugador: jugador, jugadorName: jugadorData.nombre,
            tipo: tipoApuesta, equipo: jugadorData.equipo,
            valor: tipoApuesta === 'solo' ? 2 : (tipoApuesta === 'cuatrola' ? 4 : 5)
        };
        sala.apuestas.push(apuesta);
        sala.apuestaActual = apuesta;
        
        if (tipoApuesta === 'cuatrola' || tipoApuesta === 'quintola') {
            sala.cuatrolaActiva = apuesta;
            const idx = sala.ordenJugadores.indexOf(jugador);
            sala.compañeroNoJuega = sala.ordenJugadores[(idx + 2) % 4];
            sala.cuatrolaBazasGanadas = 0;
        }
        
        io.to(salaActual).emit("apuesta_realizada", {
            jugador: jugadorData.nombre, tipo: tipoApuesta, valor: apuesta.valor,
            mensaje: `${jugadorData.nombre} apuesta ${tipoApuesta.toUpperCase()} (${apuesta.valor} pts)`
        });
        
        if (totalRespuestas + 1 >= 4) {
            sala.faseApuestas = false;
            iniciarJuegoConApuesta(sala, salaActual);
            return;
        }
        
        const siguienteIdx = (totalRespuestas + 1) % 4;
        const siguienteId = sala.ordenJugadores[(sala.manoIndex + siguienteIdx) % 4];
        const siguiente = sala.users.get(siguienteId);
        io.to(salaActual).emit("turno_apuesta", {
            jugadorId: siguienteId, jugadorNombre: siguiente ? siguiente.nombre : '',
            apuestaActual: sala.apuestaActual, mensaje: `Turno de ${siguiente ? siguiente.nombre : ''}`
        });
    });
    
    // Evento para jugar carta
    socket.on("carta_seleccionada", (jugador, carta) => {
        if (!salaActual) return;
        const sala = salas.get(salaActual);
        if (!sala) return;
        
        if (sala.faseApuestas) {
            socket.emit("error_jugada", "Fase de apuestas activa. Debes apostar o pasar.");
            return;
        }
        if (sala.compañeroNoJuega === jugador) {
            socket.emit("error_jugada", "No juegas esta mano (tu compañero hizo Cuatrola/Quintola)");
            return;
        }
        
        // Verificar si es el turno del jugador
        const jugadorActualId = sala.ordenJugadores[sala.turnoActual];
        if (jugador !== jugadorActualId) {
            const turnoDe = sala.users.get(jugadorActualId);
            socket.emit("error_turno", `No es tu turno. Le toca a: ${turnoDe ? turnoDe.nombre : 'Otro jugador'}`);
            return;
        }
        
        // Verificar si ya jugó en esta ronda
        const jugadorYaJugo = sala.cartasRonda.some((jugada) => jugada.jugador === jugador);
        if (jugadorYaJugo) {
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
        
        const usersArray = Array.from(sala.users);
        socket.emit("quitar_carta_usuario", usersArray);
        
        sala.cartitasRonda.push(carta);
        io.to(salaActual).emit("mostrar_cartas_mesa", sala.cartitasRonda);
        
        // Avanzar turno
        sala.turnoActual = (sala.turnoActual + 1) % 4;
        const siguienteTurnoId = sala.ordenJugadores[sala.turnoActual];
        const siguienteJugador = sala.users.get(siguienteTurnoId);
        
        // Si todos jugaron, calcular ganador de la BAZA
        if (sala.cartasRonda.length === 4) {
            const ganador_baza = calcularGanadorRonda(sala.ultimaCarta, sala.cartasRonda, sala.users);
            
            // Acumular cartas ganadas al equipo correspondiente
            const jugadorGanador = sala.users.get(ganador_baza.jugador);
            const cartasDeLaBaza = sala.cartasRonda.map(j => j.carta);
            
            if (jugadorGanador) {
                if (jugadorGanador.equipo === 'A') {
                    sala.cartasGanadasEquipoA.push(...cartasDeLaBaza);
                } else {
                    sala.cartasGanadasEquipoB.push(...cartasDeLaBaza);
                }
            }
            
            sala.bazasJugadasMano++;
            sala.ganadorUltimaBaza = ganador_baza.jugador;
            
            // Verificar si algún jugador del equipo ganador puede cantar (tiene 11 y 12 del mismo palo)
            const equipoGanador = jugadorGanador ? jugadorGanador.equipo : null;
            const jugadoresDelEquipo = equipoGanador ? 
                Array.from(sala.users.entries()).filter(([id, data]) => data.equipo === equipoGanador) : [];
            
            // Función para verificar si un jugador puede cantar
            function puedeCantar(cartasJugador) {
                const palos = ['Bastos', 'Copas', 'Espadas', 'Oros'];
                for (const palo of palos) {
                    const tiene11 = cartasJugador.some(c => c === `11De${palo}`);
                    const tiene12 = cartasJugador.some(c => c === `12De${palo}`);
                    if (tiene11 && tiene12) {
                        const esPaloTriunfo = paloTriunfo && palo === paloTriunfo;
                        return { puede: true, palo: palo, esTriunfo: esPaloTriunfo, puntos: esPaloTriunfo ? 40 : 20 };
                    }
                }
                return { puede: false };
            }
            
            const jugadoresQuePuedenCantar = [];
            for (const [id, data] of jugadoresDelEquipo) {
                const cantarInfo = puedeCantar(data.cartas);
                if (cantarInfo.puede) {
                    jugadoresQuePuedenCantar.push({
                        jugadorId: id,
                        jugadorName: data.nombre,
                        ...cantarInfo
                    });
                }
            }
            
            // Notificar fin de baza con info de cantes disponibles
            io.to(salaActual).emit("fin_baza", {
                ganador: ganador_baza,
                bazasJugadas: sala.bazasJugadasMano,
                totalBazas: 5,
                jugadoresQuePuedenCantar: jugadoresQuePuedenCantar,
                paloTriunfo: paloTriunfo
            });
            
            // Limpiar mesa para siguiente baza
            sala.cartasRonda = [];
            sala.cartitasRonda = [];
            
            // Verificar si terminó la MANO (5 bazas)
            if (sala.bazasJugadasMano >= 5) {
                // Calcular puntos de cartas según valores: 1=11, 3=10, 10=2, 11=3, 12=4
                function puntosCarta(carta) {
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
                
                // Determinar ganador de la RONDA (mano)
                let ganadorRonda = null;
                if (puntosA > puntosB) {
                    sala.puntosRondaEquipoA++;
                    ganadorRonda = 'A';
                } else if (puntosB > puntosA) {
                    sala.puntosRondaEquipoB++;
                    ganadorRonda = 'B';
                } else {
                    // Empate - nadie gana punto (o podría ser 0.5 para cada uno)
                    ganadorRonda = 'EMPATE';
                }
                
                // Notificar fin de ronda/mano
                const jugadoresArray = Array.from(sala.users.entries());
                io.to(salaActual).emit("fin_mano", {
                    puntosCartasA: puntosA,
                    puntosCartasB: puntosB,
                    cartasA: sala.cartasGanadasEquipoA,
                    cartasB: sala.cartasGanadasEquipoB,
                    ganadorRonda: ganadorRonda,
                    puntosRondaA: sala.puntosRondaEquipoA,
                    puntosRondaB: sala.puntosRondaEquipoB
                });
                
                io.to(salaActual).emit("actualizar_puntos", {
                    puntosRondaA: sala.puntosRondaEquipoA,
                    puntosRondaB: sala.puntosRondaEquipoB,
                    bazasMano: 0,
                    nombresEquipoA: jugadoresArray.filter((_,i) => i % 2 === 0).map(([_,d]) => d.nombre),
                    nombresEquipoB: jugadoresArray.filter((_,i) => i % 2 === 1).map(([_,d]) => d.nombre)
                });
                
                // Verificar si hay ganador de la PARTIDA (a 7 rondas)
                if (sala.puntosRondaEquipoA >= 7) {
                    sala.equipoGanador = 'A';
                    io.to(salaActual).emit("partida_ganada", {
                        equipo: 'A',
                        puntosA: sala.puntosRondaEquipoA,
                        puntosB: sala.puntosRondaEquipoB,
                        mensaje: `¡Equipo A gana la partida! ${sala.puntosRondaEquipoA} - ${sala.puntosRondaEquipoB}`
                    });
                } else if (sala.puntosRondaEquipoB >= 7) {
                    sala.equipoGanador = 'B';
                    io.to(salaActual).emit("partida_ganada", {
                        equipo: 'B',
                        puntosA: sala.puntosRondaEquipoA,
                        puntosB: sala.puntosRondaEquipoB,
                        mensaje: `¡Equipo B gana la partida! ${sala.puntosRondaEquipoB} - ${sala.puntosRondaEquipoA}`
                    });
                } else {
                    // Nueva mano - repartir cartas de nuevo
                    setTimeout(() => nuevaMano(sala), 3000);
                }
                
                // El ganador de la última baza empieza la siguiente mano
                if (sala.ganadorUltimaBaza) {
                    const ganadorIndex = sala.ordenJugadores.indexOf(sala.ganadorUltimaBaza);
                    if (ganadorIndex !== -1) {
                        sala.turnoActual = ganadorIndex;
                    }
                }
            } else {
                // El ganador de la baza empieza la siguiente
                const ganadorIndex = sala.ordenJugadores.indexOf(ganador_baza.jugador);
                if (ganadorIndex !== -1) {
                    sala.turnoActual = ganadorIndex;
                    const nuevoTurno = sala.ordenJugadores[sala.turnoActual];
                    const nuevoJugador = sala.users.get(nuevoTurno);
                    io.to(salaActual).emit("cambio_turno", nuevoTurno, nuevoJugador ? nuevoJugador.nombre : '');
                }
            }
        } else {
            // Notificar a todos de quién es el siguiente turno
            io.to(salaActual).emit("cambio_turno", siguienteTurnoId, siguienteJugador ? siguienteJugador.nombre : '');
        }
    });
    
    // Función para iniciar una nueva mano (repartir cartas nuevas)
    function nuevaMano(sala) {
        console.log(`Nueva mano en ${sala.id}`);
        
        // Resetear cartas ganadas y contadores de bazas
        sala.cartasGanadasEquipoA = [];
        sala.cartasGanadasEquipoB = [];
        sala.bazasJugadasMano = 0;
        sala.cartasRonda = [];
        sala.cartitasRonda = [];
        
        // Repartir nuevas cartas
        let arrayCartitas = repartirCartas();
        let i = 0;
        
        sala.users.forEach((valor, clave) => {
            valor.cartas = arrayCartitas[i];
            i++;
        });
        
        sala.ultimaCarta = arrayCartitas[3][4];
        const usersArray = Array.from(sala.users);
        
        // El ganador de la última baza de la mano anterior empieza
        const primerTurno = sala.ordenJugadores[sala.turnoActual];
        const primerJugador = sala.users.get(primerTurno);
        
        // Enviar evento de nueva mano
        io.to(sala.id).emit("nueva_mano", {
            users: usersArray,
            ultimaCarta: sala.ultimaCarta,
            primerTurno: primerTurno,
            primerTurnoNombre: primerJugador ? primerJugador.nombre : '',
            puntosRondaA: sala.puntosRondaEquipoA,
            puntosRondaB: sala.puntosRondaEquipoB
        });
        
        // Actualizar cartas de cada jugador
        const usersJSON = JSON.stringify(Array.from(sala.users.entries()));
        io.to(sala.id).emit('usuariosJSON', usersJSON);
    }
    
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
    
    // Desconexión
    socket.on("disconnect", () => {
        console.log("Desconectado: " + socket.id);
        if (salaActual) {
            const sala = salas.get(salaActual);
            if (sala) {
                const jugadorDesconectado = sala.users.get(socket.id);
                const nombreJugador = jugadorDesconectado ? jugadorDesconectado.nombre : 'Jugador';
                
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
                
                // Si el juego estaba iniciado y quedan menos de 4, terminar juego
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
                    sala.juegoIniciado = false;
                    sala.cartasRonda = [];
                    sala.cartitasRonda = [];
                    sala.ultimaCarta = null;
                    sala.todos_limpian = 0;
                    sala.turnoActual = 0;
                    sala.ordenJugadores = [];
                }
            }
        }
    });
});

server.listen(PORT)
console.log('Server iniciado en puerto: ', PORT)