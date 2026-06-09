# Observabilidad — Fundecodes

## Requisitos
- Docker Desktop instalado y corriendo
- Backend corriendo en `localhost:4000`

## Levantar Prometheus + Grafana

```bash
cd observability
docker compose up -d
```

| Servicio    | URL                        | Usuario  | Contraseña      |
|-------------|----------------------------|----------|-----------------|
| Prometheus  | http://localhost:9090      | —        | —               |
| Grafana     | http://localhost:3001      | admin    | fundecodes2024  |

## Verificar métricas del backend

```
GET http://localhost:4000/metrics
```

## Alertas configuradas

| # | Nombre               | Condición                                     | Severidad |
|---|----------------------|-----------------------------------------------|-----------|
| 1 | HighHttpErrorRate    | >10% de requests son errores (2m window)      | warning   |
| 2 | HighHeapMemoryUsage  | Heap de Node.js > 250 MB (2m sostenido)       | warning   |
| 3 | SlowApiResponses     | Latencia p95 > 2s en alguna ruta (1m window)  | critical  |

## Simulación de carga

```bash
cd observability/load-test

# Carga normal (30 req/s, 60s)
node load-test.js

# Carga alta — dispara alertas de latencia y CPU
node load-test.js --mode stress --rps 150 --duration 120

# Generar errores — dispara alerta de error rate
node load-test.js --mode error --rps 50 --duration 60

# Personalizado
node load-test.js --url http://localhost:4000 --rps 80 --duration 90 --mode stress
```
