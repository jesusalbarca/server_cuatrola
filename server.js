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
        
        // Enviar info de equipos
        const equiposInfo = {};
        sala.users.forEach((valor, clave) => {
            equiposInfo[clave] = { equipo: valor.equipo, numero: valor.numeroJugador };
        });
        
        io.to(sala.id).emit("start_game", usersArray, sala.ultimaCarta, primerTurno, primerJugador ? primerJugador.nombre : '', equiposInfo);
        
        // Enviar info de compañeros (quién es compañero de quién)
        // Fórmula: (idx + 2) % 4 → 0↔2, 1↔3
        const companerosInfo = {};
        const jugadoresArray = Array.from(sala.users.entries());
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
        
        // Si la carta es del palo de salida, siempre es válida (asistir)
        if (paloCarta === paloSalida) {
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
        
        // No tiene palo de salida. Verificar si debe fallar (triunfo) OBLIGATORIAMENTE
        if (paloTriunfo && paloCarta === paloTriunfo) {
            // Está fallando con triunfo, es válido
            return { valida: true, esFallo: true };
        }
        
        // No es triunfo. Verificar si tiene triunfos (obligado a fallar)
        const tieneTriunfo = cartasJugador.some(c => getPalo(c) === paloTriunfo);
        if (tieneTriunfo) {
            // Tiene triunfos, está obligado a fallar
            return {
                valida: false,
                mensaje: `Debes fallar: tienes triunfos (${paloTriunfo}). Debes jugar un triunfo obligatoriamente.`
            };
        }
        
        // No tiene palo de salida ni triunfos, puede jugar cualquier otra carta
        return { valida: true, esDescarte: true };
    }
    
    // Evento para jugar carta
    socket.on("carta_seleccionada", (jugador, carta) => {
        if (!salaActual) return;
        const sala = salas.get(salaActual);
        if (!sala) return;
        
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
            
            // Notificar fin de baza
            io.to(salaActual).emit("fin_baza", {
                ganador: ganador_baza,
                bazasJugadas: sala.bazasJugadasMano,
                totalBazas: 5
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