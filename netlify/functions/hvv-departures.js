const fetch = require('node-fetch');

const HAFAS_BASE = 'https://v5.bvg.transport.rest';

exports.handler = async (event, context) => {
  try {
    // Station "Garstedt" suchen
    const stationSearchRes = await fetch(`${HAFAS_BASE}/locations?query=Garstedt&results=5`);
    if (!stationSearchRes.ok) throw new Error('Station search failed');
    
    const locations = await stationSearchRes.json();
    const garstedtStation = locations.find(loc => loc.name && loc.name.includes('Garstedt'));
    
    if (!garstedtStation || !garstedtStation.id) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Garstedt station not found' })
      };
    }

    // Abfahrten abrufen
    const departuresRes = await fetch(`${HAFAS_BASE}/stops/${garstedtStation.id}/departures?results=20`);
    if (!departuresRes.ok) throw new Error('Departures fetch failed');
    
    const allDepartures = await departuresRes.json();

    // U1 filtern
    const u1Departures = allDepartures
      .filter(dep => {
        const isU1 = dep.line && (
          dep.line.name === 'U 1' || 
          dep.line.name === 'U1' || 
          (dep.line.product === 'subway' && dep.line.name?.includes('1'))
        );
        return isU1;
      })
      .slice(0, 5)
      .map(dep => ({
        time: new Date(dep.when).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
        destination: dep.direction || 'Ohlsdorf',
        delay: dep.delay ? Math.floor(dep.delay / 60) : 0,
        minToDepart: Math.max(0, Math.ceil((new Date(dep.when) - new Date()) / 60000))
      }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=60'
      },
      body: JSON.stringify({
        success: true,
        departures: u1Departures,
        timestamp: new Date().toISOString()
      })
    };
  } catch (error) {
    console.error('HVV error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};
