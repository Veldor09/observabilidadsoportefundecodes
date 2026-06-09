/**
 * load-test.js — Script de simulación de carga para Fundecodes Backend
 *
 * Uso:
 *   node load-test.js [--url http://localhost:4000] [--rps 50] [--duration 60]
 *
 * Parámetros:
 *   --url       Base URL del backend (default: http://localhost:4000)
 *   --rps       Requests por segundo (default: 30)
 *   --duration  Duración en segundos (default: 60)
 *   --mode      normal | stress | error
 *               normal = carga moderada
 *               stress = carga alta (dispara alerta de latencia y CPU)
 *               error  = genera errores 404/401 (dispara alerta de error rate)
 */

const http = require('http');
const https = require('https');

// ── Leer argumentos ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, def) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : def;
}

const BASE_URL  = arg('--url',      'http://localhost:4001');
const RPS       = parseInt(arg('--rps',      '30'), 10);
const DURATION  = parseInt(arg('--duration', '60'), 10);
const MODE      = arg('--mode', 'normal');

// ── Endpoints disponibles ──────────────────────────────────────────────────────
const ENDPOINTS = {
  normal: [
    '/healthz',
    '/api/dashboard/metrics',
    '/api/projects',
    '/api/voluntarios',
  ],
  stress: [
    '/api/dashboard/metrics',
    '/api/dashboard/stats/projects',
    '/api/projects',
    '/api/voluntarios',
    '/api/billing/requests',
    '/api/contabilidad/transacciones',
    '/api/auditoria',
    '/api/colaboradores',
  ],
  error: [
    '/api/ruta-que-no-existe',
    '/api/proyectos/99999999',
    '/api/usuarios/0',
    '/api/dashboard/metrics',
  ],
};

const endpoints = ENDPOINTS[MODE] || ENDPOINTS.normal;
const client    = BASE_URL.startsWith('https') ? https : http;

// ── Contadores ─────────────────────────────────────────────────────────────────
let sent = 0, ok = 0, errors = 0, active = 0;

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function doRequest() {
  const path = pickRandom(endpoints);
  const url  = `${BASE_URL}${path}`;
  active++;

  const req = client.get(url, { timeout: 5000 }, (res) => {
    res.resume();
    res.on('end', () => {
      active--;
      sent++;
      res.statusCode < 400 ? ok++ : errors++;
    });
  });

  req.on('error', () => { active--; sent++; errors++; });
  req.on('timeout', () => { req.destroy(); active--; sent++; errors++; });
}

// ── Mostrar estado cada segundo ───────────────────────────────────────────────
function printStatus(elapsed) {
  const pctErrors = sent > 0 ? ((errors / sent) * 100).toFixed(1) : '0.0';
  process.stdout.write(
    `\r[${String(elapsed).padStart(3)}s] Enviadas: ${sent}  OK: ${ok}  Errores: ${errors} (${pctErrors}%)  Activas: ${active}  `
  );
}

// ── Bucle principal ────────────────────────────────────────────────────────────
console.log(`\n=== Fundecodes Load Test ===`);
console.log(`URL:      ${BASE_URL}`);
console.log(`Modo:     ${MODE}`);
console.log(`Carga:    ${RPS} req/s durante ${DURATION}s`);
console.log(`Inicio:   ${new Date().toLocaleTimeString()}\n`);

const intervalMs = 1000 / RPS;
let elapsed = 0;

const requestInterval = setInterval(doRequest, intervalMs);

const statusInterval = setInterval(() => {
  elapsed++;
  printStatus(elapsed);
  if (elapsed >= DURATION) {
    clearInterval(requestInterval);
    clearInterval(statusInterval);

    // Esperar requests en vuelo
    const wait = setInterval(() => {
      if (active === 0) {
        clearInterval(wait);
        const pctErrors = sent > 0 ? ((errors / sent) * 100).toFixed(1) : '0.0';
        console.log(`\n\n=== Resultado ===`);
        console.log(`Total enviadas : ${sent}`);
        console.log(`Exitosas       : ${ok}`);
        console.log(`Errores        : ${errors} (${pctErrors}%)`);
        console.log(`Fin:             ${new Date().toLocaleTimeString()}`);
        process.exit(0);
      }
    }, 200);
  }
}, 1000);
