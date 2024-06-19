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

// Ejemplo de uso:
const ultimaCarta = '10DeOros';
const cartasRonda = [
  { jugador: 'djvoV_ZCShwrUQ7mAAAP', carta: '11DeBastos' },
  { jugador: 'OBa-HQSGmnekNzueAAAN', carta: '1DeBastos' },
  { jugador: 'SQfuNJhVwoHTAJiqAAAL', carta: '10DeBastos' },
  { jugador: '0WSkAjb6mNtNS7dGAAAJ', carta: '1DeCopas' }
];

const ganador = calcularGanadorRonda(ultimaCarta, cartasRonda);
console.log('El ganador de la ronda es:', ganador);
