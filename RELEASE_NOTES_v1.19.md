# Planner v1.19 – Stabiliteit / self-healing

Deze versie is gericht op het oplossen van het probleem “bij langere reisoptie hangt de server soms”.

## Wat is er aangepast

- **Watchdog (event-loop lag + geheugen)**  
  Meet elke paar seconden of de event-loop vastloopt of het geheugen ongezond oploopt.  
  Als dit meerdere keren achter elkaar gebeurt, **stopt het proces bewust** (exit code 1) zodat je host (bijv. Render) het automatisch kan herstarten.

- **Crash-fast handlers**  
  `uncaughtException` en `unhandledRejection` worden gelogd en daarna wordt het proces afgesloten zodat het niet in een half-broken toestand blijft hangen.

- **Trip-cache: cleanup + max keys**  
  De trips-cache had een korte TTL, maar **oude entries werden niet actief opgeschoond**, waardoor het geheugen in de praktijk toch kon blijven groeien bij veel verschillende requests.  
  v1.19 voegt:
  - periodieke cleanup
  - een maximum aantal cache-keys (oude entries worden verwijderd)

- **HTTP/request timeouts**  
  Extra timeouts op socket/server niveau om “hangende” connecties niet te laten opstapelen.

- **/health uitgebreid**  
  Geeft nu ook uptime, geheugen en laatste event-loop lag terug.

## Optionele environment variabelen

Je hoeft niets te zetten; dit zijn defaults.

- `REQ_TIMEOUT_MS` (default 30000)
- `SERVER_REQUEST_TIMEOUT_MS` (default 35000)
- `SERVER_HEADERS_TIMEOUT_MS` (default 40000)
- `SERVER_KEEPALIVE_TIMEOUT_MS` (default 5000)

- `TRIP_TTL_MS` (default 20000)
- `TRIP_MAX_KEYS` (default 2500)

- `WATCHDOG_INTERVAL_MS` (default 5000)
- `WATCHDOG_MAX_LAG_MS` (default 2000)
- `WATCHDOG_MAX_HEAP_MB` (default 450)
- `WATCHDOG_STRIKES` (default 3)

## Opmerking

De “zelf oplossen” strategie werkt het beste als je hosting het proces automatisch herstart wanneer het stopt (Render, Heroku, Docker met restart policy, PM2, etc.).
