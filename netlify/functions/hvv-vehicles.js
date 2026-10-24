// U1 live: Fahrzeugbewegungen der U1 rund um Garstedt (Geofox GTI, Methode getVehicleMap)
// Liefert pro Fahrt die Streckenabschnitte mit Zeiten und Gleisverlauf. Die Seite ubahn-live.html
// berechnet daraus die aktuelle Position jedes Zuges (keine GPS Ortung).
const fetch = require('node-fetch');
const crypto = require('crypto');

const GTI_BASE = 'https://gti.geofox.de';
const GEOFOX_USER = process.env.GEOFOX_USER;
const GEOFOX_PASSWORD = process.env.GEOFOX_PASSWORD;

// Kartenausschnitt: Norderstedt Mitte bis Fuhlsbüttel Nord (WGS84, x = Länge, y = Breite)
const BOX = {
  lowerLeft: { x: 9.95, y: 53.615, type: 'EPSG_4326' },
  upperRight: { x: 10.07, y: 53.72, type: 'EPSG_4326' },
};
const LINE_NAME = 'U1';
const WINDOW_BEFORE_S = 5 * 60;  // etwas Vergangenheit, damit gerade fahrende Züge vollständig sind
const WINDOW_AFTER_S = 20 * 60;  // 20 Minuten Zukunft: Animation bis zur nächsten Abfrage, Strecke vollständig

function sign(bodyString) {
  return crypto.createHmac('sha1', GEOFOX_PASSWORD).update(bodyString, 'utf8').digest('base64');
}

async function gtiRequest(path, bodyObj) {
  const bodyString = JSON.stringify(bodyObj);
  const res = await fetch(`${GTI_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept': 'application/json',
      'geofox-auth-type': 'HmacSHA1',
      'geofox-auth-user': GEOFOX_USER,
      'geofox-auth-signature': sign(bodyString),
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
    const err = new Error(`GTI Fehler bei ${path}: ${json.errorText || json.errorDevInfo || json.returnCode || res.status}`);
    err.gti = json;
    throw err;
  }
  return json;
}

// Zeitangaben können als Sekunden oder Millisekunden kommen; hier immer auf Millisekunden bringen
function toMs(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

// track: [x1, y1, x2, y2, ...] (Länge, Breite) -> [[breite, länge], ...] für die Karte
function toLatLngs(track) {
  const arr = (track && track.track) || [];
  const out = [];
  for (let i = 0; i + 1 < arr.length; i += 2) {
    const x = Number(arr[i]);
    const y = Number(arr[i + 1]);
    if (isFinite(x) && isFinite(y)) out.push([Math.round(y * 1e6) / 1e6, Math.round(x * 1e6) / 1e6]);
  }
  return out;
}

function isLine(journey) {
  const name = String((journey.line && journey.line.name) || '').replace(/\s+/g, '').toUpperCase();
  return name === LINE_NAME;
}

function compactJourney(j) {
  const segments = (j.segments || [])
    .map((s) => ({
      from: s.startStationName || '',
      to: s.endStationName || '',
      fromKey: s.startStationKey || s.startStopPointKey || '',
      toKey: s.endStationKey || s.endStopPointKey || '',
      start: toMs(s.startDateTime),
      end: toMs(s.endDateTime),
      delay: typeof s.realtimeDelay === 'number' ? s.realtimeDelay : 0,
      destination: s.destination || '',
      isFirst: !!s.isFirst,
      isLast: !!s.isLast,
      track: toLatLngs(s.track),
    }))
    .filter((s) => s.start && s.end && s.track.length >= 2)
    .sort((a, b) => a.start - b.start);

  const lastWithDest = segments.slice().reverse().find((s) => s.destination);
  return {
    id: String(j.journeyID || ''),
    line: (j.line && j.line.name) || LINE_NAME,
    direction: (j.line && j.line.direction) || '',
    destination: (lastWithDest && lastWithDest.destination) || (j.line && j.line.direction) || '',
    realtime: !!j.realtime,
    segments,
  };
}

exports.handler = async (event) => {
  if (!GEOFOX_USER || !GEOFOX_PASSWORD) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: 'GEOFOX_USER / GEOFOX_PASSWORD sind nicht als Umgebungsvariable gesetzt.' }),
    };
  }

  const debug = event && event.queryStringParameters && event.queryStringParameters.debug === '1';
  const nowS = Math.floor(Date.now() / 1000);
  const baseRequest = {
    version: 63,
    boundingBox: BOX,
    periodBegin: nowS - WINDOW_BEFORE_S,
    periodEnd: nowS + WINDOW_AFTER_S,
    withoutCoords: false,
    coordinateType: 'EPSG_4326',
    realtime: true,
  };

  try {
    // 1. Versuch: nur U-Bahnen anfragen. Falls der Fahrzeugtyp anders heißt oder nichts kommt,
    //    2. Versuch ohne Typ Filter (dann kommen auch Busse, die U1 wird unten herausgefiltert).
    let raw;
    let usedFallback = false;
    try {
      raw = await gtiRequest('/gti/public/getVehicleMap', { ...baseRequest, vehicleTypes: ['U_BAHN'] });
    } catch (e) {
      raw = null;
    }
    let journeys = (raw && raw.journeys) || [];
    if (!journeys.some(isLine)) {
      usedFallback = true;
      raw = await gtiRequest('/gti/public/getVehicleMap', baseRequest);
      journeys = (raw && raw.journeys) || [];
    }

    const u1 = journeys.filter(isLine).map(compactJourney).filter((j) => j.segments.length > 0);

    const body = {
      success: true,
      serverNow: Date.now(),
      line: LINE_NAME,
      journeys: u1,
      usedFallback,
    };
    if (debug) {
      body.debug = {
        journeysTotal: journeys.length,
        lineNames: [...new Set(journeys.map((j) => j.line && j.line.name))].slice(0, 30),
        firstRawJourney: journeys.find(isLine) || journeys[0] || null,
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' },
      body: JSON.stringify(body),
    };
  } catch (error) {
    console.error('getVehicleMap Fehler:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' },
      body: JSON.stringify({ success: false, error: error.message, gti: debug ? error.gti : undefined }),
    };
  }
};
