const fetch = require('node-fetch');
const crypto = require('crypto');

const GTI_BASE = 'https://gti.geofox.de';

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
    throw new Error(`Ungültige Antwort von ${path}: ${text.substring(0, 300)}`);
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
    const grResponse = await gtiRequest('/gti/public/getRoute', {
      start: { name: 'Garstedt', type: 'STATION' },
      dest: { name: 'Poppenbüttel', type: 'STATION' },
      time: { date: 'heute', time: 'jetzt' },
      schedulesBefore: 0, // keine bereits vergangenen Verbindungen als Kontext mitliefern
      schedulesAfter: 4, // ein paar weitere Verbindungen nach der besten mit anzeigen
    });

    const schedules = grResponse.schedules || [];

    const connections = schedules.slice(0, 5).map((s) => {
      const elements = s.scheduleElements || [];
      const first = elements[0];
      const last = elements[elements.length - 1];
      const lines = elements
        .map((e) => (e.line && e.line.name) || null)
        .filter(Boolean);

      return {
        departureRaw: first && first.from && first.from.depTime ? first.from.depTime : null,
        arrivalRaw: last && last.to && last.to.arrTime ? last.to.arrTime : null,
        lines,
        changes: typeof s.changes === 'number' ? s.changes : Math.max(0, lines.length - 1),
      };
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, max-age=0',
      },
      body: JSON.stringify({
        success: true,
        connections,
        raw: schedules.length > 0 ? schedules[0] : null, // zur Fehlersuche im Frontend mitgeben
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error('GTI route error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: error.message }),
    };
  }
};
