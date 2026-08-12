const fetch = require('node-fetch');
const crypto = require('crypto');

const GTI_BASE = 'https://gti.geofox.de';

// Zugangsdaten kommen aus Netlify Umgebungsvariablen (Site settings -> Environment variables)
// GEOFOX_USER = ChristianBuggenthin
// GEOFOX_PASSWORD = das Passwort aus der HVV-Mail
const GEOFOX_USER = process.env.GEOFOX_USER;
const GEOFOX_PASSWORD = process.env.GEOFOX_PASSWORD;

function sign(bodyString) {
  return crypto
    .createHmac('sha1', GEOFOX_PASSWORD)
    .update(bodyString, 'utf8')
    .digest('base64');
}

async function gtiRequest(path, bodyObj) {
  const bodyString = JSON.stringify(bodyObj);
  const signature = sign(bodyString);

  const res = await fetch(`${GTI_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept': 'application/json',
      'geofox-auth-type': 'HmacSHA1',
      'geofox-auth-user': GEOFOX_USER,
      'geofox-auth-signature': signature,
      'X-Platform': 'web',
    },
    body: bodyString,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Ungültige Antwort von ${path}: ${text.substring(0, 200)}`);
  }

  if (!res.ok || (json.returnCode && json.returnCode !== 'OK')) {
    throw new Error(`GTI Fehler bei ${path}: ${json.errorText || json.returnCode || res.status}`);
  }

  return json;
}

exports.handler = async (event, context) => {
  if (!GEOFOX_USER || !GEOFOX_PASSWORD) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'GEOFOX_USER / GEOFOX_PASSWORD sind nicht als Umgebungsvariable gesetzt.',
      }),
    };
  }

  try {
    // 1. Station "Garstedt" suchen
    const cnResponse = await gtiRequest('/gti/public/checkName', {
      theName: { name: 'Garstedt' },
      maxList: 6,
    });

    const results = cnResponse.results || [];
    const garstedt = results.find(
      (r) => r.type === 'STATION' && r.name && r.name.includes('Garstedt')
    );

    if (!garstedt) {
      return {
        statusCode: 404,
        body: JSON.stringify({ success: false, error: 'Station Garstedt nicht gefunden', raw: results }),
      };
    }

    // 2. Abfahrten für diese Station abrufen
    const dlResponse = await gtiRequest('/gti/public/departureList', {
      station: { id: garstedt.id, type: 'STATION', name: garstedt.name },
      time: { date: formatDate(new Date()), time: formatTime(new Date()) },
      maxList: 20,
      maxTimeOffset: 90,
      useRealtime: true,
    });

    const departures = dlResponse.departures || [];

    // 3. Auf U1 Richtung Ohlsdorf filtern
    const u1 = departures
      .filter((dep) => {
        const lineName = dep.line && dep.line.name;
        return lineName && lineName.replace(/\s/g, '').toUpperCase() === 'U1';
      })
      .slice(0, 5)
      .map((dep) => {
        const plannedTime = dep.timeOffset != null
          ? new Date(Date.now() + dep.timeOffset * 60000)
          : null;
        return {
          line: dep.line.name,
          destination: (dep.line && dep.line.direction) || dep.direction || 'Ohlsdorf',
          minToDepart: dep.timeOffset != null ? dep.timeOffset : null,
          time: plannedTime
            ? plannedTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })
            : null,
          delay: dep.delay ? Math.round(dep.delay / 60) : 0,
          cancelled: !!dep.cancelled,
        };
      });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=60',
      },
      body: JSON.stringify({
        success: true,
        station: garstedt.name,
        departures: u1,
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error('GTI error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  }
};

function formatDate(d) {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
function formatTime(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
