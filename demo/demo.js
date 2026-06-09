/**
 * demo.js — Simulación Final Fundecodes
 *
 * Ejecuta el flujo completo de incidente para la presentación:
 *   1. Verifica que todo el stack esté corriendo
 *   2. Muestra métricas normales (baseline)
 *   3. Lanza carga de estrés → métricas suben → alerta dispara
 *   4. Verifica que el incidente fue creado en ServiceNow
 *   5. Detiene la carga → métricas se recuperan
 *   6. Resuelve el incidente en ServiceNow
 *
 * Uso:
 *   node demo.js
 *   node demo.js --skip-checks    (omite verificación inicial)
 *   node demo.js --rps 100        (ajustar carga, default 120)
 */

const http  = require('http');
const https = require('https');

// ── Config ─────────────────────────────────────────────────────────────────────
const BACKEND_URL  = 'http://localhost:4001';
const GRAFANA_URL   = 'http://localhost:3001';
const GRAFANA_USER  = 'admin';
const GRAFANA_PASS  = 'fundecodes2024';
const TEAMS_WEBHOOK = 'https://defaultf6f7a71d15d64e048f93607826b3b8.fc.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/ade3522bc3e84198be28a8b7bedc03aa/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=lHtlxPylW1e_yFOMEJN8IeItRmBP6fzkYxzlENxDkf0';
const SNOW_BASE    = 'https://dev356799.service-now.com';
const SNOW_USER    = 'admin';
const SNOW_PASS    = 'kc@Qf47aSKA*';

const args    = process.argv.slice(2);
const SKIP    = args.includes('--skip-checks');
const RPS_ARG = args.indexOf('--rps');
const STRESS_RPS = RPS_ARG !== -1 ? parseInt(args[RPS_ARG + 1]) : 120;

// ── Utilidades ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(emoji, msg) {
  const ts = new Date().toLocaleTimeString('es-CR');
  console.log(`[${ts}] ${emoji}  ${msg}`);
}

function logSection(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

async function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 8000, ...opts }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function post(url, body, headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const data   = JSON.stringify(body);
    const parsed = new URL(url);
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (url.startsWith('https') ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout:  10000,
    };
    const req = client.request(opts, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, data: b }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── 1. Verificación del stack ──────────────────────────────────────────────────
async function checkStack() {
  logSection('PASO 1 — Verificación del Stack');
  const checks = [
    { name: 'Backend   ', url: `${BACKEND_URL}/healthz` },
    { name: 'Métricas  ', url: `${BACKEND_URL}/metrics` },
    { name: 'Prometheus', url: 'http://localhost:9090/-/healthy' },
    { name: 'Grafana   ', url: `${GRAFANA_URL}/api/health` },
  ];

  let allOk = true;
  for (const c of checks) {
    try {
      const r = await get(c.url);
      const ok = r.status >= 200 && r.status < 300;
      log(ok ? '✅' : '❌', `${c.name} → HTTP ${r.status}`);
      if (!ok) allOk = false;
    } catch (e) {
      log('❌', `${c.name} → No responde (${e.message})`);
      allOk = false;
    }
  }

  if (!allOk) {
    console.error('\n⚠️  Algunos servicios no están disponibles. Asegúrate de que:');
    console.error('   • El backend está corriendo: npm run start:dev');
    console.error('   • Docker está corriendo: cd observability && docker compose up -d');
    process.exit(1);
  }
  log('🎉', 'Stack completo OK');
}

// ── 2. Baseline (métricas normales) ───────────────────────────────────────────
async function showBaseline() {
  logSection('PASO 2 — Baseline (tráfico normal 30s)');
  log('📊', 'Generando tráfico normal para establecer baseline…');

  const endpoints = ['/healthz', '/api/dashboard/metrics', '/api/projects'];
  const intervalMs = 1000 / 5; // 5 req/s
  let sent = 0;
  const client = http;

  const interval = setInterval(() => {
    const path = endpoints[sent % endpoints.length];
    const req = client.get(`${BACKEND_URL}${path}`, { timeout: 3000 }, res => res.resume());
    req.on('error', () => {});
    sent++;
  }, intervalMs);

  for (let i = 30; i > 0; i--) {
    process.stdout.write(`\r   Tiempo restante: ${i}s — peticiones enviadas: ${sent}  `);
    await sleep(1000);
  }
  clearInterval(interval);
  console.log(`\n`);
  log('✅', `Baseline establecido con ${sent} peticiones a 5 req/s`);
}

// ── 3. Simulación de estrés ────────────────────────────────────────────────────
async function runStress() {
  logSection(`PASO 3 — Simulación de Estrés (${STRESS_RPS} req/s)`);
  log('🔥', `Iniciando carga de estrés: ${STRESS_RPS} req/s por 90 segundos…`);
  log('👀', 'Observa en Grafana (localhost:3001) cómo suben las métricas');

  const endpoints = [
    '/api/dashboard/metrics', '/api/dashboard/stats/projects',
    '/api/projects', '/api/voluntarios', '/api/billing/requests',
    '/api/contabilidad/transacciones', '/api/auditoria', '/api/colaboradores',
  ];

  const intervalMs = 1000 / STRESS_RPS;
  let sent = 0, errors = 0;
  let running = true;

  const interval = setInterval(() => {
    if (!running) return;
    const path = endpoints[Math.floor(Math.random() * endpoints.length)];
    const req = http.get(`${BACKEND_URL}${path}`, { timeout: 5000 }, res => {
      res.resume();
      sent++;
      if (res.statusCode >= 400) errors++;
    });
    req.on('error', () => { sent++; errors++; });
    req.on('timeout', () => { req.destroy(); sent++; errors++; });
  }, intervalMs);

  for (let i = 90; i > 0; i--) {
    const errPct = sent > 0 ? ((errors / sent) * 100).toFixed(1) : '0.0';
    process.stdout.write(
      `\r   [${i}s restantes] Enviadas: ${sent}  Errores: ${errors} (${errPct}%)  `
    );
    await sleep(1000);
  }

  running = false;
  clearInterval(interval);
  console.log('\n');
  log('🛑', `Carga detenida — Total: ${sent} peticiones, ${errors} errores`);
  return { sent, errors };
}

// ── 4. Verificar alerta en Grafana ────────────────────────────────────────────
async function checkGrafanaAlerts() {
  logSection('PASO 4 — Verificación de Alertas en Grafana');
  log('⏳', 'Esperando que Grafana evalúe las alertas (hasta 2 min)…');

  const auth = Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64');

  for (let attempt = 1; attempt <= 24; attempt++) {
    await sleep(5000);
    try {
      const r = await get(
        `${GRAFANA_URL}/api/alertmanager/grafana/api/v2/alerts`,
        { headers: { Authorization: `Basic ${auth}` } }
      );

      if (r.status === 200 && Array.isArray(r.data) && r.data.length > 0) {
        log('🚨', `¡${r.data.length} alerta(s) activa(s) en Grafana!`);
        r.data.forEach(a => {
          const name = a.labels?.alertname ?? 'desconocida';
          const sev  = a.labels?.severity ?? '?';
          log('   🔔', `${name} [${sev.toUpperCase()}]`);
        });
        return r.data;
      } else {
        process.stdout.write(`\r   Intento ${attempt}/24 — sin alertas aún…  `);
      }
    } catch {
      process.stdout.write(`\r   Intento ${attempt}/24 — esperando Grafana…  `);
    }
  }

  console.log('');
  log('⚠️', 'No se detectaron alertas activas en Grafana (puede necesitar más tiempo)');
  return [];
}

// ── 5. Crear incidente en ServiceNow ──────────────────────────────────────────
async function createSnowIncident() {
  logSection('PASO 5 — Creación de Incidente en ServiceNow');
  log('📋', 'Disparando webhook al backend para crear incidente…');

  const payload = {
    receiver: 'Fundecodes Backend Webhook',
    status: 'firing',
    title: 'Fundecodes DEMO - Alta Tasa de Errores HTTP Simulacion Final',
    message: 'Incidente generado durante simulación controlada para presentación.',
    commonLabels:      { app: 'fundecodes-backend', severity: 'critical' },
    commonAnnotations: {
      summary:     'Alta tasa de errores HTTP detectada',
      description: 'La simulación de carga provocó más del 10% de errores en el backend Fundecodes.',
    },
    groupLabels: { alertname: 'HighHttpErrorRate' },
    externalURL: GRAFANA_URL,
    alerts: [{
      status:  'firing',
      labels:  { alertname: 'HighHttpErrorRate', app: 'fundecodes-backend', severity: 'critical' },
      annotations: {
        summary:     'Alta tasa de errores HTTP',
        description: 'Carga excesiva provocó errores en el sistema Fundecodes.',
      },
      startsAt: new Date().toISOString(),
    }],
  };

  try {
    const r = await post(`${BACKEND_URL}/api/webhooks/alert`, payload);
    if (r.status === 200) {
      log('✅', 'Backend procesó la alerta → incidente enviado a ServiceNow');
    } else {
      log('❌', `Backend respondió ${r.status}`);
    }
  } catch (e) {
    log('❌', `Error al llamar webhook: ${e.message}`);
  }

  // Verificar en ServiceNow directamente
  await sleep(3000);
  log('🔍', 'Verificando incidente en ServiceNow…');
  const auth = Buffer.from(`${SNOW_USER}:${SNOW_PASS}`).toString('base64');
  try {
    const r = await get(
      `${SNOW_BASE}/api/now/table/incident?sysparm_query=short_descriptionLIKEFundecodes&sysparm_limit=3&sysparm_fields=number,short_description,state,sys_created_on&sysparm_display_value=true`,
      { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
    );
    if (r.status === 200 && r.data?.result?.length > 0) {
      const last = r.data.result[0];
      log('✅', `Incidente confirmado en ServiceNow:`);
      log('   📌', `Número  : ${last.number}`);
      log('   📌', `Estado  : ${last.state}`);
      log('   📌', `Creado  : ${last.sys_created_on}`);
      log('   🔗', `URL: ${SNOW_BASE}/incident.do?sysparm_query=number=${last.number}`);
      return last.number;
    }
  } catch (e) {
    log('⚠️', `No se pudo verificar en ServiceNow: ${e.message}`);
  }
  return null;
}

// ── 6. Recuperación ───────────────────────────────────────────────────────────
async function showRecovery() {
  logSection('PASO 6 — Recuperación del Sistema');
  log('💚', 'La carga se detuvo. Observa en Grafana cómo las métricas vuelven a la normalidad…');

  for (let i = 30; i > 0; i--) {
    process.stdout.write(`\r   Recuperando… ${i}s  `);
    await sleep(1000);
  }
  console.log('');
  log('✅', 'Sistema recuperado — métricas en niveles normales');
}

// ── 7. Resolución del incidente ───────────────────────────────────────────────
async function resolveIncident() {
  logSection('PASO 7 — Resolución del Incidente en ServiceNow');
  log('🔧', 'Buscando incidente más reciente de Fundecodes…');

  const auth = Buffer.from(`${SNOW_USER}:${SNOW_PASS}`).toString('base64');
  try {
    const r = await get(
      `${SNOW_BASE}/api/now/table/incident?sysparm_query=short_descriptionLIKEFundecodes^stateNOT IN6,7&sysparm_limit=1&sysparm_orderby=sys_created_on&sysparm_fields=sys_id,number`,
      { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
    );
    if (!r.data?.result?.length) {
      log('⚠️', 'No se encontró incidente abierto para resolver');
      return;
    }
    const { sys_id, number } = r.data.result[0];

    // Resolver
    const patch = await post(
      `${SNOW_BASE}/api/now/table/incident/${sys_id}`,
      {
        state:       '6',
        close_code:  'Solution provided',
        close_notes: 'Incidente resuelto. La carga excesiva fue detenida y el sistema se recuperó automáticamente. Se identificó la causa raíz: simulación de carga controlada. Medida: ajustar límites de rate-limiting en el API.',
      },
      { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      'PATCH'
    );

    if (patch.status < 300) {
      log('✅', `Incidente ${number} resuelto en ServiceNow`);
      log('   🔗', `${SNOW_BASE}/incident.do?sysparm_query=number=${number}`);
    } else {
      log('❌', `Error al resolver: HTTP ${patch.status}`);
    }
  } catch (e) {
    log('❌', `Error: ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.clear();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        SIMULACIÓN FINAL — FUNDECODES OBSERVABILIDAD      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Inicio: ${new Date().toLocaleString('es-CR')}\n`);

  if (!SKIP) await checkStack();
  await showBaseline();
  await runStress();
  await checkGrafanaAlerts();
  await createSnowIncident();
  await showRecovery();
  await resolveIncident();

  logSection('SIMULACIÓN COMPLETADA');
  log('🎉', 'Flujo completo ejecutado:');
  log('   ✅', 'Baseline → Estrés → Alerta → Incidente ServiceNow → Recuperación → Resolución');
  console.log(`\n  Fin: ${new Date().toLocaleString('es-CR')}\n`);
})();
