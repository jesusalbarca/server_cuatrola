import express from "express";
import { Server as SocketServer } from "socket.io";
import http from 'http'
import cors from 'cors'

const PORT = 4000 || process.env.PORT
//antes localhost ahora 192.168.1.137

const app = express();
const server = http.createServer(app)
const io = new SocketServer(server, {
    cors:{
        origin: '*'
    }
})

app.get('/', (req, res) => {
    res.send("Hola")
    console.log("Get OK")
})  

app.use(cors())

var todos_limpian = 0

const cartasDisponibles = ['1DeOros', '3DeOros', '10DeOros', '11DeOros', '12DeOros',
                           '1DeCopas', '3DeCopas', '10DeCopas', '11DeCopas', '12DeCopas',
                           '1DeEspadas', '3DeEspadas', '10DeEspadas', '11DeEspadas', '12DeEspadas',
                           '1DeBastos', '3DeBastos', '10DeBastos', '11DeBastos', '12DeBastos'];

let cartas_jugadores = [[], [], [], []];

function repartirCartas() {
    const cartas = cartasDisponibles.slice(); // Copiamos las cartas disponibles para evitar modificar la lista original

    // Distribuir cartas a los jugadores
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 5; j++) { // Se reparten 5 cartas a cada jugador (20 cartas en total)
            const cartaIndex = Math.floor(Math.random() * cartas.length);
            cartas_jugadores[i].push(cartas[cartaIndex]);
            cartas.splice(cartaIndex, 1);
        }
    }
	
	return cartas_jugadores;
}


var users = new Map ();
var usuario;

var ultimaCarta = [];
var cartasRonda = []
var cartitasRonda = []

io.on('connection' , (socket) =>{
    console.log("nuevo cliente socket " + socket.id)
	
	socket.on("disconnect", (reason) => {   
      console.log("desconectado: " + socket.id)
	 });
	
	 socket.on("nuevo_jugador", (nombre) => { 
	  let datos_usuario = {}
	  datos_usuario.nombre = nombre
	  datos_usuario.cartas = "vacio hasta k haya 4 "
      console.log("nuevo_jugador: " + JSON.stringify(datos_usuario))
	  users.set(socket.id, datos_usuario);
	  
	  if(users.size === 4){
		  console.log("empieza el juego")
		  let arrayCartitas = repartirCartas()
		  //console.log(arrayCartitas)
		  let i = 0;
		  users.forEach((valor, clave) => {
			//console.log(`Clave: ${clave}, Valor: ${JSON.stringify(valor)}`);
			valor.cartas = arrayCartitas[i]
			i++
		  });
		  console.log(users)
		  //punto 1.1 
		  // Convertir el Map a un arreglo de pares clave-valor
		  const usersArray = Array.from(users);
		  //el 3 hace referencia al ultimo jugardor. Este debe ir cambiando 
		  console.log(arrayCartitas[3][4])
		  ultimaCarta = arrayCartitas[3][4]
		  io.emit("start_game", usersArray, ultimaCarta)
		  
		  //alternativa a 1.1 para los usurios
		  var usersJSON = JSON.stringify(Array.from(users.entries()));
          console.log(usersJSON)
          io.emit('usuariosJSON', usersJSON);
	  }
	 
	 });
	 
	  socket.on("carta_seleccionada", (jugador,carta) => {
		  	    let jugada = {};

 // Verificar si el jugador ya ha jugado una carta en esta ronda
		  const jugadorYaJugo = cartasRonda.some((jugada) => jugada.jugador === jugador);

		  if (jugadorYaJugo) {
			console.log(`El jugador ${jugador} ya ha jugado una carta en esta ronda.`);
			// Puedes emitir un mensaje al jugador indicando que ya ha jugado una carta, o manejarlo de acuerdo a tus necesidades.
			return;
		  }		  
		jugada.jugador = jugador;
		jugada.carta = carta
		cartasRonda.push(jugada)
		console.log(cartasRonda)
		//controlar que la carta que hecha es valida
		 
		//...
		//Quitar la carta que ha elegido el jugador de su mano y enviarla a la mesa 
		//console.log(users)
	
		// Clonar el objeto correspondiente
		let objetoModificar = Object.assign({}, users.get(jugador));

		// Filtrar la carta a eliminar del array de cartas
		objetoModificar.cartas = objetoModificar.cartas.filter(cartaOriginal => cartaOriginal !== carta);

		// Modificar el mapa original con el objeto modificado
		users.set(jugador, objetoModificar);
		console.log("--------------------------------------")

		//console.log(users)
		const usersArray = Array.from(users);
		socket.emit("quitar_carta_usuario",usersArray)
		
		cartitasRonda.push(carta)

		io.emit("mostrar_cartas_mesa", cartitasRonda)
		
		if (cartasRonda.length == 4){
			//elegir ganador de la ronda  
			console.log("fin ronda")
			//A lo que se va 
			console.log(ultimaCarta)
			//Calcular ganador de la ronda teniendo en cuenta quien es el que ha empezado la ronda 
			console.log(cartasRonda)
			var ganador_ronda = calcularGanadorRonda(ultimaCarta,cartasRonda )
			console.log(ganador_ronda)
			//Controlar que quien gane la ronda, empieza la siguiente siempre que no sea la ultia ronda
			io.emit("fin_ronda", ganador_ronda)
			//habrá que guardar quien ha ganado y las cartas para guardar los puntos
			//las cartas ronda a 0 (en realidad ese una mano no una ronda)
			cartasRonda = []
			//OJO tienes aqui dos variables parecidas pero una no hace lo que otra
			cartitasRonda = []
			
		}
	 });
	 
	 socket.on("limpiar_mesa", () => {  
	 
		console.log("limpar mesa")
		//consiste en enviar el array cartasRonda vacio a todos 
		todos_limpian = todos_limpian + 1;
		if (todos_limpian % 4 == 0){
			io.emit("vaciar_mesa")

		}
	 });
	 /*
	 socket.on("iniciar_ronda", (users,ultimaCarta) => { 
		console.log(users)
		console.log(ultimaCarta)
	 });
	 */
	 



});
   
function calcularGanadorRonda(ultimaCarta, cartasRonda) {
  const falloGanaATodos = cartasRonda.every((carta) => carta.carta === ultimaCarta);

  // Filtrar las cartas del fallo
  const cartasFallo = cartasRonda.filter((carta) => carta.carta.startsWith(ultimaCarta.split('De')[1]));

  // Si el fallo gana a todos o hay alguna carta del fallo del mismo palo, devuelve la primera carta del fallo
  if (falloGanaATodos || cartasFallo.length > 0) {
    const cartaGanadora = cartasFallo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    return { ...cartaGanadora, paloGanador: ultimaCarta.split('De')[1], jugador_name: obtenerNombreJugador(cartaGanadora.jugador) };
  }

  // Filtrar las cartas del mismo palo que el fallo
  const paloFallo = ultimaCarta.split('De')[1];
  const cartasMismoPalo = cartasRonda.filter((carta) => carta.carta.endsWith(paloFallo));

  // Si hay cartas del mismo palo, devuelve la primera carta del mismo palo después de ordenar
  if (cartasMismoPalo.length > 0) {
    const cartaGanadora = cartasMismoPalo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    return { ...cartaGanadora, paloGanador: paloFallo, jugador_name: obtenerNombreJugador(cartaGanadora.jugador) };
  }

  // Si no, devuelve la primera carta después de ordenar
  const cartaGanadora = cartasRonda.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
  return { ...cartaGanadora, paloGanador: null, jugador_name: obtenerNombreJugador(cartaGanadora.jugador) };
}

// Función para obtener el valor numérico de una carta según las reglas de la cuatrola
function valorCarta(carta) {
  const valorNumerico = parseInt(carta.match(/\d+/)[0], 10);

  switch (valorNumerico) {
    case 1: // As (1)
      return 5; // Asignamos un valor alto para que sea el más alto
    case 3: // Tres
      return 4;
    case 12: // Sota (10)
      return 3;
    case 11: // Caballo (11)
      return 2;
    case 10: // Rey (12)
      return 1;
    default: // Cartas numéricas
      return valorNumerico;
  }
}

// Función para obtener el nombre del jugador a partir de su ID
function obtenerNombreJugador(idJugador, usersMap) {
  const jugador = users.get(idJugador);
  return jugador ? jugador.nombre : 'Jugador Desconocido';
}

/*

OKKK pero devuelve solo jugadorID 
function calcularGanadorRonda(ultimaCarta, cartasRonda) {
  const falloGanaATodos = cartasRonda.every((carta) => carta.carta === ultimaCarta);

  // Filtrar las cartas del fallo
  const cartasFallo = cartasRonda.filter((carta) => carta.carta.startsWith(ultimaCarta.split('De')[1]));

  // Si el fallo gana a todos o hay alguna carta del fallo del mismo palo, devuelve la primera carta del fallo
  if (falloGanaATodos || cartasFallo.length > 0) {
    const cartaGanadora = cartasFallo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    return { ...cartaGanadora, paloGanador: ultimaCarta.split('De')[1] };
  }

  // Filtrar las cartas del mismo palo que el fallo
  const paloFallo = ultimaCarta.split('De')[1];
  const cartasMismoPalo = cartasRonda.filter((carta) => carta.carta.endsWith(paloFallo));

  // Si hay cartas del mismo palo, devuelve la primera carta del mismo palo después de ordenar
  if (cartasMismoPalo.length > 0) {
    const cartaGanadora = cartasMismoPalo.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
    return { ...cartaGanadora, paloGanador: paloFallo };
  }

  // Si no, devuelve la primera carta después de ordenar
  const cartaGanadora = cartasRonda.sort((a, b) => valorCarta(b.carta) - valorCarta(a.carta))[0];
  return { ...cartaGanadora, paloGanador: null };
}

// Función para obtener el valor numérico de una carta según las reglas de la cuatrola
function valorCarta(carta) {
  const valorNumerico = parseInt(carta.match(/\d+/)[0], 10);

  switch (valorNumerico) {
    case 1: // As (1)
      return 5; // Asignamos un valor alto para que sea el más alto
    case 3: // Tres
      return 4;
    case 12: // Sota (10)
      return 3;
    case 11: // Caballo (11)
      return 2;
    case 10: // Rey (12)
      return 1;
    default: // Cartas numéricas
      return valorNumerico;
  }
}
*/
server.listen(PORT)
console.log('Server iniciado en puerto: ', PORT)


/* Trabajar con salas 
// En el servidor
const roomId = 'nombreDeLaSala'; // Puedes generar un ID único para cada sala
socket.join(roomId);
// En el servidor
io.to(roomId).emit('mensaje_personalizado', data);




*/