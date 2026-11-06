/* Places in St. Vincent used for pickups and destinations. Coordinates are approximate town centres. */
window.SR_PLACES = [
  { name: "Kingstown", lat: 13.1562, lng: -61.2276 },
  { name: "Arnos Vale", lat: 13.1431, lng: -61.2117 },
  { name: "Argyle International Airport", lat: 13.1567, lng: -61.1499 },
  { name: "SVGCC, Villa", lat: 13.1350, lng: -61.1995 },
  { name: "Calliaqua", lat: 13.1296, lng: -61.1925 },
  { name: "Villa", lat: 13.1335, lng: -61.2010 },
  { name: "Fort Charlotte", lat: 13.1601, lng: -61.2370 },
  { name: "Botanic Gardens", lat: 13.1660, lng: -61.2283 },
  { name: "Richland Park", lat: 13.1878, lng: -61.1826 },
  { name: "Mesopotamia", lat: 13.1715, lng: -61.1755 },
  { name: "Greiggs", lat: 13.2060, lng: -61.1760 },
  { name: "Biabou", lat: 13.1960, lng: -61.1395 },
  { name: "Georgetown", lat: 13.2780, lng: -61.1200 },
  { name: "Colonarie", lat: 13.2380, lng: -61.1360 },
  { name: "Layou", lat: 13.2020, lng: -61.2690 },
  { name: "Barrouallie", lat: 13.2380, lng: -61.2690 },
  { name: "Chateaubelair", lat: 13.2900, lng: -61.2440 },
  { name: "Vermont", lat: 13.1930, lng: -61.2220 },
  { name: "Campden Park", lat: 13.1720, lng: -61.2470 },
  { name: "Brighton", lat: 13.1230, lng: -61.1730 },
  { name: "Diamond", lat: 13.1450, lng: -61.1580 },
  { name: "Peruvian Vale", lat: 13.1630, lng: -61.1420 },
];
window.SR_nearestPlace = function (lat, lng) {
  var best = null, bd = Infinity;
  window.SR_PLACES.forEach(function (p) { var d = Math.pow(p.lat - lat, 2) + Math.pow((p.lng - lng) * 0.97, 2); if (d < bd) { bd = d; best = p; } });
  return best;
};
window.SR_inSVG = function (lat, lng) { return lat > 12.4 && lat < 13.45 && lng > -61.5 && lng < -61.0; };
