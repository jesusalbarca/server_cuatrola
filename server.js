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
        ordenJugadores: [] // Array con los socket IDs en orden de turno
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
        
        let arrayCartitas = repartirCartas();
        let i = 0;
        
        // Guardar orden de jugadores para los turnos
        sala.ordenJugadores = Array.from(sala.users.keys());
        sala.turnoActual = 0;
        
        sala.users.forEach((valor, clave) => {
            valor.cartas = arrayCartitas[i];
            i++;
        });
        
        sala.ultimaCarta = arrayCartitas[3][4];
        const usersArray = Array.from(sala.users);
        
        // Determinar quién tiene el primer turno (el primero en el orden)
        const primerTurno = sala.ordenJugadores[0];
        const primerJugador = sala.users.get(primerTurno);
        
        io.to(sala.id).emit("start_game", usersArray, sala.ultimaCarta, primerTurno, primerJugador ? primerJugador.nombre : '');
        
        const usersJSON = JSON.stringify(Array.from(sala.users.entries()));
        io.to(sala.id).emit('usuariosJSON', usersJSON);
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
        
        // Si todos jugaron, calcular ganador
        if (sala.cartasRonda.length === 4) {
            const ganador_ronda = calcularGanadorRonda(sala.ultimaCarta, sala.cartasRonda, sala.users);
            io.to(salaActual).emit("fin_ronda", ganador_ronda);
            sala.cartasRonda = [];
            sala.cartitasRonda = [];
            // El ganador empieza la siguiente ronda
            const ganadorIndex = sala.ordenJugadores.indexOf(ganador_ronda.jugador);
            if (ganadorIndex !== -1) {
                sala.turnoActual = ganadorIndex;
                const nuevoTurno = sala.ordenJugadores[sala.turnoActual];
                const nuevoJugador = sala.users.get(nuevoTurno);
                io.to(salaActual).emit("cambio_turno", nuevoTurno, nuevoJugador ? nuevoJugador.nombre : '');
            }
        } else {
            // Notificar a todos de quién es el siguiente turno
            io.to(salaActual).emit("cambio_turno", siguienteTurnoId, siguienteJugador ? siguienteJugador.nombre : '');
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