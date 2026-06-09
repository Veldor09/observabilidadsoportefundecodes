/**
 * test-servicenow.js — Prueba la integración con ServiceNow
 *
 * Uso:
 *   node test-servicenow.js --instance https://dev356799.service-now.com --user admin --password Secret123
 *
 * O con variables de entorno:
 *   $env:SERVICENOW_INSTANCE="https://dev356799.service-now.com"
 *   $env:SERVICENOW_USER="admin"
 *   $env:SERVICENOW_PASSWORD="Secret123"
 *   node test-servicenow.js
 */

const http  = require('http');
const https = require('https');

const args = process.argv.slice(2);
function arg(name, def) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : def;
}

const INSTANCE = arg('--instance', process.env.SERVICENOW_INSTANCE || '');
const USER     = arg('--user',     process.env.SERVICENOW_USER     || '');
const PASSWORD = arg('--password', process.env.SERVICENOW_PASSWORD || '');

if (!INSTANCE || !USER || !PASSWORD) {
  console.error('❌  Faltan credenciales. Usa --instance, --user, --password');
  process.exit(1);
}

const BASE_HOST = INSTANCE.startsWith('http')
  ? INSTANCE.replace(/\/$/, '')
  : `https://${INSTANCE}.service-now.com`;
const BASE = `${BASE_HOST}/api/now`;
const AUTH = Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Basic ${AUTH}`,
  'Accept': 'application/json',
};

// ── Helper: request con https.request (evita bugs de fetch en Windows) ─────────
function request(url, method, body) {
  return new Promise((resolve, reject) => {
    const data    = body ? JSON.stringify(body) : null;
    const parsed  = new URL(url);
    const client  = url.startsWith('https') ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method,
      headers:  {
        ...COMMON_HEADERS,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 90000,
    };

    const req = client.request(opts, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (data) req.write(data);
    req.end();
  });
}

// ── 1. Crear incidente ─────────────────────────────────────────────────────────
async function createIncident() {
  console.log(`\n📡  Creando incidente de prueba en ${BASE_HOST}…`);

  let res, intento = 0;
  while (intento < 4) {
    intento++;
    if (intento > 1) {
      console.log(`   ↻ Reintento ${intento}/4 (instancia dev puede ser lenta)…`);
      await new Promise(r => setTimeout(r, 5000));
    }
    try {
      res = await request(`${BASE}/table/incident`, 'POST', {
        short_description: 'Fundecodes TEST - Alerta alta tasa de errores HTTP',
        urgency: '2',
        impact:  '2',
      });
      if (res.status < 400) break; // éxito
      if (intento === 4) {
        console.error('❌  Error al crear incidente:', JSON.stringify(res.data, null, 2));
        process.exit(1);
      }
    } catch (err) {
      if (intento === 4) throw err;
      console.log(`   ↻ Error de red (${err.message}), reintentando…`);
    }
  }

  const { number, sys_id, state, short_description } = res.data.result;
  console.log('✅  Incidente creado:');
  console.log(`    Número   : ${number}`);
  console.log(`    ID       : ${sys_id}`);
  console.log(`    Estado   : ${state}`);
  console.log(`    Resumen  : ${short_description}`);
  console.log(`    URL      : ${BASE_HOST}/incident.do?sys_id=${sys_id}`);
  return sys_id;
}

// ── 2. Simular webhook de Grafana al backend local ─────────────────────────────
async function simulateGrafanaWebhook() {
  console.log(`\n🔔  Simulando webhook de Grafana al backend local…`);

  const payload = {
    receiver: 'Fundecodes Backend Webhook',
    status: 'firing',
    title: '[TEST] Alta Tasa de Errores HTTP',
    message: 'Más del 10% de las peticiones están fallando.',
    commonLabels: { app: 'fundecodes-backend', severity: 'warning' },
    commonAnnotations: {
      summary: 'Alta tasa de errores HTTP en Fundecodes',
      description: 'Condición disparada durante prueba de carga.',
    },
    groupLabels: { alertname: 'HighHttpErrorRate' },
    externalURL: 'http://localhost:3001',
    alerts: [{
      status: 'firing',
      labels: { alertname: 'HighHttpErrorRate', app: 'fundecodes-backend', severity: 'warning' },
      annotations: { summary: 'Alta tasa de errores HTTP', description: 'Más del 10% de peticiones fallando.' },
      startsAt: new Date().toISOString(),
    }],
  };

  try {
    const res = await request('http://localhost:4001/api/webhooks/alert', 'POST', payload);
    if (res.status < 400) {
      console.log('✅  Backend procesó la alerta:', JSON.stringify(res.data));
    } else {
      console.log('❌  Backend error:', JSON.stringify(res.data));
    }
  } catch (err) {
    console.warn('⚠️   Backend no disponible en localhost:4001:', err.message);
  }
}

// ── 3. Resolver incidente ──────────────────────────────────────────────────────
async function resolveIncident(sys_id) {
  console.log(`\n🔧  Resolviendo incidente ${sys_id}…`);

  const res = await request(`${BASE}/table/incident/${sys_id}`, 'PATCH', {
    state:       '6',
    close_code:  'Solution provided',
    close_notes: 'Incidente de prueba resuelto. El sistema volvio a niveles normales.',
  });

  if (res.status >= 400) {
    console.error('❌  Error al resolver:', JSON.stringify(res.data));
    return;
  }
  console.log('✅  Incidente resuelto correctamente.');
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const sys_id = await createIncident();
    await simulateGrafanaWebhook();
    await new Promise(r => setTimeout(r, 3000));
    await resolveIncident(sys_id);
    console.log('\n🎉  Prueba completa.\n');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
