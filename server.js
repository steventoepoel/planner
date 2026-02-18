// server.js (Render-ready, p-limit + rate limiting + caching + slimme Extreme-B)
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { promises as fsp } from "fs";
import pLimit from "p-limit";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

/* =========================
   Rate limiting (beveiliging)
   ========================= */

// algemeen (sitebreed)
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 min
    max: 180, // 180 req/min per IP
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// "dure" endpoints (NS trips)
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/reis", heavyLimiter);
app.use("/reis-extreme-b", heavyLimiter);

// autocomplete (stations)
const stationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/stations", stationLimiter);

/* =========================
   NS API
   ========================= */

const API_KEY = process.env.NS_API_KEY;
if (!API_KEY) console.error("❌ NS_API_KEY ontbreekt in environment variables");

const headers = { "Ocp-Apim-Subscription-Key": API_KEY };

// Extreme parameters (zoals je al gebruikte)
const EXTREME = {
  minTransferTime: 0,
  additionalTransferTime: 0,
  searchForAccessibleTrip: false,
};

function requireApiKey(res) {
  if (!API_KEY) {
    res.status(500).json({ error: "NS API key ontbreekt op de server (NS_API_KEY)" });
    return false;
  }
  return true;
}

/* =========================
   Concurrency limits (p-limit)
   ========================= */

const limitTrips = pLimit(6);
const limitStations = pLimit(4);

/* =========================
   Fetch helpers (timeout + status)
   ========================= */

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJsonStrict(url, options = {}, ms = 10000) {
  const r = await fetchWithTimeout(url, options, ms);
  const text = await r.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // ignore
  }

  if (!r.ok) {
    const msg = data?.error || data?.message || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  if (!data) throw new Error("Server gaf geen JSON terug");
  return data;
}

/* =========================
   FAVORIETEN (async fs)
   ========================= */

const FAVORIET_FILE = "./favorieten.json";

async function ensureFavFile() {
  try {
    await fsp.access(FAVORIET_FILE);
  } catch {
    await fsp.writeFile(FAVORIET_FILE, JSON.stringify([], null, 2));
  }
}

async function readFavs() {
  try {
    const txt = await fsp.readFile(FAVORIET_FILE, "utf-8");
    const data = JSON.parse(txt);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeFavs(favs) {
  await fsp.writeFile(FAVORIET_FILE, JSON.stringify(favs, null, 2));
}

await ensureFavFile();

app.get("/favorieten", async (req, res) => {
  res.json(await readFavs());
});

app.post("/favorieten", async (req, res) => {
  const { van, naar } = req.body || {};
  if (!van || !naar) return res.status(400).json({ error: "van/naar ontbreken" });

  const favs = await readFavs();
  favs.push({ van, naar });
  await writeFavs(favs);
  res.json({ ok: true });
});

app.delete("/favorieten/:index", async (req, res) => {
  const idx = Number(req.params.index);
  const favs = await readFavs();

  if (!Number.isInteger(idx) || idx < 0 || idx >= favs.length) {
    return res.status(400).json({ error: "ongeldige index" });
  }

  favs.splice(idx, 1);
  await writeFavs(favs);
  res.json({ ok: true });
});

/* =========================
   STATIONS (autocomplete) + cache TTL
   ========================= */

const stationSearchCache = new Map(); // key -> {t,payload}
const STATION_TTL_MS = 10 * 60 * 1000; // 10 min

async function fetchStationsCached(q) {
  const key = (q || "").trim().toLowerCase();
  if (!key) return [];

  const hit = stationSearchCache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < STATION_TTL_MS) return hit.payload;

  const url = `https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/stations?q=${encodeURIComponent(
    q
  )}`;

  const data = await limitStations(() => fetchJsonStrict(url, { headers }, 8000));
  const payload = data.payload || [];

  stationSearchCache.set(key, { t: now, payload });
  return payload;
}

app.get("/stations", async (req, res) => {
  if (!requireApiKey(res)) return;
  const q = String(req.query.q || "");
  if (!q.trim()) return res.json([]);

  try {
    const payload = await fetchStationsCached(q);
    res.json(payload);
  } catch (err) {
    console.error("Stations fout:", err.message || err);
    res.status(500).json({ error: "Stations ophalen mislukt" });
  }
});

/* =========================
   TRIPS helpers
   ========================= */

async function fetchTrips({ from, to, dateTimeISO, extraParams = {} }) {
  const base = new URL("https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips");
  base.searchParams.set("fromStation", from);
  base.searchParams.set("toStation", to);
  base.searchParams.set("dateTime", dateTimeISO);

  for (const [k, v] of Object.entries(extraParams)) {
    if (v !== undefined && v !== null && String(v).length > 0) {
      base.searchParams.set(k, String(v));
    }
  }

  return await limitTrips(() => fetchJsonStrict(base.toString(), { headers }, 10000));
}

function tripToOption(trip) {
  const legs = trip.legs || [];
  if (!legs.length) return null;

  const depart = legs[0]?.origin?.plannedDateTime;
  const arrive = legs[legs.length - 1]?.destination?.plannedDateTime;
  if (!depart || !arrive) return null;

  const depT = Date.parse(depart);
  const arrT = Date.parse(arrive);
  if (!isFinite(depT) || !isFinite(arrT)) return null;

  const durationMin = Math.round((arrT - depT) / 60000);

  let minTransferMin = null;
  for (let i = 0; i < legs.length - 1; i++) {
    const a = Date.parse(legs[i]?.destination?.plannedDateTime);
    const b = Date.parse(legs[i + 1]?.origin?.plannedDateTime);
    if (!isFinite(a) || !isFinite(b)) continue;
    const m = Math.round((b - a) / 60000);
    if (minTransferMin === null || m < minTransferMin) minTransferMin = m;
  }

  return {
    mode: "trip",
    durationMin,
    depart,
    arrive,
    minTransferMin,
    legs: legs.map((l) => ({
      originName: l.origin?.name,
      destName: l.destination?.name,
      dep: l.origin?.plannedDateTime,
      arr: l.destination?.plannedDateTime,
      depTrack: l.origin?.plannedTrack ?? null,
      arrTrack: l.destination?.plannedTrack ?? null,
      delayMin: l.origin?.delayInMinutes ?? 0,
      product: l.product?.longCategoryName || l.product?.shortCategoryName || "Trein",
    })),
  };
}

function combineOptions(optA, optB) {
  const depart = optA.depart;
  const arrive = optB.arrive;

  const depT = Date.parse(depart);
  const arrT = Date.parse(arrive);
  if (!isFinite(depT) || !isFinite(arrT)) return null;

  const durationMin = Math.round((arrT - depT) / 60000);

  const aArr = Date.parse(optA.arrive);
  const bDep = Date.parse(optB.depart);
  const transferMin = Math.round((bDep - aArr) / 60000);

  let minTransferMin = optA.minTransferMin;
  if (minTransferMin === null || minTransferMin === undefined) minTransferMin = transferMin;
  minTransferMin = Math.min(minTransferMin, transferMin);

  if (optB.minTransferMin !== null && optB.minTransferMin !== undefined) {
    minTransferMin = Math.min(minTransferMin, optB.minTransferMin);
  }

  return {
    mode: "combo",
    durationMin,
    depart,
    arrive,
    minTransferMin,
    legs: [...optA.legs, ...optB.legs],
  };
}

function optionSignature(o) {
  const legsSig = (o.legs || [])
    .map((l) => `${l.originName || ""}>${l.destName || ""}@${l.dep || ""}-${l.arr || ""}`)
    .join("~");
  return `${o.depart}|${o.arrive}|${o.durationMin}|${legsSig}`;
}

/* =========================
   /reis (NORMAAL)
   ========================= */

app.get("/reis", async (req, res) => {
  if (!requireApiKey(res)) return;
  const { van, naar, datetime, extreme } = req.query;
  if (!van || !naar || !datetime) return res.status(400).json({ error: "Parameters ontbreken" });

  try {
    const extra = {};
    if (extreme === "1") Object.assign(extra, EXTREME);

    const data = await fetchTrips({
      from: String(van),
      to: String(naar),
      dateTimeISO: String(datetime),
      extraParams: extra,
    });

    res.json(data);
  } catch (err) {
    console.error("Reis fout:", err.message || err);
    res.status(500).json({ error: "Reis ophalen mislukt" });
  }
});

/* =========================
   /reis-extreme-b (SLIMMER)
   - kiest beste via’s op basis van frequentie
   - p-limit parallel
   - pruned search (TOP_A / TOP_B / MAX_TRANSFER)
   ========================= */

app.get("/reis-extreme-b", async (req, res) => {
  if (!requireApiKey(res)) return;
  const { van, naar, datetime } = req.query;
  if (!van || !naar || !datetime) return res.status(400).json({ error: "Parameters ontbreken" });

  const FROM = String(van);
  const TO = String(naar);
  const DT = String(datetime);

  // Tunables (sneller = lager, meer opties = hoger)
  const MAX_VIA = 8; // maximaal aantal via-stations om te proberen
  const TOP_A = 5; // top A-opties per via
  const TOP_B = 8; // top B-opties per A
  const MAX_TRANSFER = 20; // alleen overstappen 0..20 min
  const TARGET = 10; // output count

  function scoreOption(o) {
    // lagere score = beter
    const minT = o.minTransferMin ?? 999;
    const penalty = minT > 10 ? (minT - 10) * 2 : 0;
    return o.durationMin + penalty;
  }

  try {
    // 1) Basis trips (extreme)
    const base = await fetchTrips({
      from: FROM,
      to: TO,
      dateTimeISO: DT,
      extraParams: EXTREME,
    });

    const baseTrips = Array.isArray(base.trips) ? base.trips : [];

    // 2) Baseline opties (directe trips)
    const options = baseTrips.map(tripToOption).filter(Boolean);

    // Als we al genoeg hebben: sorteer en return
    if (options.length >= TARGET) {
      options.sort((a, b) => scoreOption(a) - scoreOption(b));
      return res.json({ options: options.slice(0, TARGET) });
    }

    // 3) Verzamel via-namen + frequentie
    const viaCount = new Map();
    for (const t of baseTrips) {
      const legs = t.legs || [];
      for (let i = 0; i < legs.length - 1; i++) {
        const nm = legs[i]?.destination?.name;
        if (!nm) continue;
        viaCount.set(nm, (viaCount.get(nm) || 0) + 1);
      }
    }

    const viaNames = Array.from(viaCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_VIA)
      .map(([nm]) => nm);

    // 4) Resolve via codes parallel + cached station search
    const viaCodeResults = await Promise.all(
      viaNames.map((nm) =>
        limitStations(async () => {
          const q = nm.slice(0, 12);
          const payload = await fetchStationsCached(q);
          const hit = payload.find(
            (s) => (s.namen?.lang || "").toLowerCase() === nm.toLowerCase()
          );
          return hit?.code || null;
        })
      )
    );
    const viaCodes = viaCodeResults.filter(Boolean);

    // 5) Generate combos
    const best = [];
    function pushBest(o) {
      best.push(o);
      if (best.length > 60) {
        best.sort((a, b) => scoreOption(a) - scoreOption(b));
        best.length = 40;
      }
    }

    await Promise.all(
      viaCodes.map((via) =>
        limitTrips(async () => {
          // A: FROM -> VIA
          const aData = await fetchTrips({
            from: FROM,
            to: via,
            dateTimeISO: DT,
            extraParams: EXTREME,
          });

          const aTrips = Array.isArray(aData.trips) ? aData.trips : [];
          const aOpts = aTrips
            .map(tripToOption)
            .filter(Boolean)
            .sort((x, y) => x.durationMin - y.durationMin)
            .slice(0, TOP_A);

          // B calls parallel for each A
          await Promise.all(
            aOpts.map(async (optA) => {
              const bData = await fetchTrips({
                from: via,
                to: TO,
                dateTimeISO: optA.arrive,
                extraParams: EXTREME,
              });

              const bTrips = Array.isArray(bData.trips) ? bData.trips : [];
              const bOpts = bTrips.map(tripToOption).filter(Boolean).slice(0, TOP_B);

              for (const optB of bOpts) {
                const transferMin = Math.round(
                  (Date.parse(optB.depart) - Date.parse(optA.arrive)) / 60000
                );
                if (transferMin < 0 || transferMin > MAX_TRANSFER) continue;

                const c = combineOptions(optA, optB);
                if (c) pushBest(c);
              }
            })
          );
        })
      )
    );

    // 6) Merge + dedup + sort
    const all = [...options, ...best].filter(Boolean);
    const seen = new Set();
    const deduped = [];

    for (const o of all) {
      const key = optionSignature(o);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(o);
      }
    }

    deduped.sort((a, b) => scoreOption(a) - scoreOption(b));
    res.json({ options: deduped.slice(0, TARGET) });
  } catch (err) {
    console.error("Extreme B fout:", err.message || err);
    res.status(500).json({ error: "Extreme B ophalen mislukt" });
  }
});

/* =========================
   Start
   ========================= */

app.listen(PORT, () => {
  console.log(`✅ Server draait op http://localhost:${PORT} (PORT=${PORT})`);
});
