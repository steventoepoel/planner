// server.js (Render production)
// p-limit + rate limiting + caching + prefix fallback + slimme Extreme-B + OVapi (bus/tram/metro)

import dns from "dns";
dns.setDefaultResultOrder("ipv4first"); // ✅ belangrijk voor Render/IPv6 issues

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { promises as fsp } from "fs";
import pLimit from "p-limit";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();

/** ✅ Render / proxies: MOET vóór rate-limit */
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

app.use(express.json());

/* =========================
   Security headers (lightweight)
   ========================= */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/* =========================
   Static files (cache)
   ========================= */
app.use(
  express.static("public", {
    maxAge: "1h",
    etag: true,
  })
);

/* =========================
   Rate limiting
   ========================= */
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 180, // algemeen
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40, // trips endpoints
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/reis", heavyLimiter);
app.use("/reis-extreme-b", heavyLimiter);

const stationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 140, // autocomplete
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/stations", stationLimiter);

/* =========================
   NS API
   ========================= */
const API_KEY = process.env.NS_API_KEY;
const headers = API_KEY ? { "Ocp-Apim-Subscription-Key": API_KEY } : null;

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
   Health
   ========================= */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(API_KEY),
    node: process.version,
  });
});

/* =========================
   Concurrency (p-limit)
   ========================= */
const limitTrips = pLimit(6);
const limitStations = pLimit(4);

/* =========================
   Fetch helpers (timeout + JSON strict)
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
   STATIONS (autocomplete) — FAST
   ========================= */
const stationCache = new Map(); // key -> {t, payload}
const stationInFlight = new Map(); // key -> Promise
const STATION_TTL_MS = 30 * 60 * 1000; // 30 min
const STATION_MAX_KEYS = 2000; // safety cap

function stationCacheGet(key) {
  const hit = stationCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > STATION_TTL_MS) {
    stationCache.delete(key);
    return null;
  }
  return hit.payload;
}

function stationCacheSet(key, payload) {
  stationCache.set(key, { t: Date.now(), payload });

  if (stationCache.size > STATION_MAX_KEYS) {
    const entries = Array.from(stationCache.entries()).sort((a, b) => a[1].t - b[1].t);
    const removeCount = stationCache.size - STATION_MAX_KEYS;
    for (let i = 0; i < removeCount; i++) stationCache.delete(entries[i][0]);
  }
}

function bestPrefixCached(key) {
  for (let i = key.length - 1; i >= 2; i--) {
    const pref = key.slice(0, i);
    const val = stationCacheGet(pref);
    if (val) return val;
  }
  return null;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stationCache.entries()) {
    if (now - v.t > STATION_TTL_MS) stationCache.delete(k);
  }
}, 10 * 60 * 1000).unref();

async function fetchStationsFromNS(q) {
  const url = `https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/stations?q=${encodeURIComponent(q)}`;
  const data = await limitStations(() => fetchJsonStrict(url, { headers }, 8000));
  return data.payload || [];
}

async function fetchStationsCached(q) {
  const key = (q || "").trim().toLowerCase();
  if (!key) return [];

  const exact = stationCacheGet(key);
  if (exact) return exact;

  if (stationInFlight.has(key)) return stationInFlight.get(key);

  const p = (async () => {
    try {
      const payload = await fetchStationsFromNS(q);
      stationCacheSet(key, payload);
      return payload;
    } finally {
      stationInFlight.delete(key);
    }
  })();

  stationInFlight.set(key, p);
  return p;
}

app.get("/stations", async (req, res) => {
  if (!requireApiKey(res)) return;

  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);

  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  const key = q.toLowerCase();

  try {
    const exact = stationCacheGet(key);

    if (!exact) {
      const pref = bestPrefixCached(key);
      if (pref) {
        res.json(pref);
        fetchStationsCached(q).catch(() => {});
        return;
      }
    }

    const payload = exact || (await fetchStationsCached(q));
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
      origin: l.origin || null,
      destination: l.destination || null,
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

  if (!Number.isFinite(transferMin) || transferMin < 0) return null;

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
   ========================= */
app.get("/reis-extreme-b", async (req, res) => {
  if (!requireApiKey(res)) return;

  const { van, naar, datetime } = req.query;
  if (!van || !naar || !datetime) return res.status(400).json({ error: "Parameters ontbreken" });

  const FROM = String(van);
  const TO = String(naar);
  const DT = String(datetime);

  const MAX_VIA = 8;
  const TOP_A = 5;
  const TOP_B = 8;
  const MAX_TRANSFER = 20;
  const TARGET = 10;

  function scoreOption(o) {
    const minT = o.minTransferMin ?? 999;
    const penalty = minT > 10 ? (minT - 10) * 2 : 0;
    return o.durationMin + penalty;
  }

  try {
    const base = await fetchTrips({
      from: FROM,
      to: TO,
      dateTimeISO: DT,
      extraParams: EXTREME,
    });

    const baseTrips = Array.isArray(base.trips) ? base.trips : [];
    const options = baseTrips.map(tripToOption).filter(Boolean);

    if (options.length >= TARGET) {
      options.sort((a, b) => scoreOption(a) - scoreOption(b));
      return res.json({ options: options.slice(0, TARGET) });
    }

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

    const viaCodeResults = await Promise.all(
      viaNames.map((nm) =>
        limitStations(async () => {
          const q = nm.slice(0, 12);
          const payload = await fetchStationsCached(q);
          const hit = payload.find((s) => (s.namen?.lang || "").toLowerCase() === nm.toLowerCase());
          return hit?.code || null;
        })
      )
    );

    const viaCodes = viaCodeResults.filter(Boolean);

    const best = [];
    function pushBest(o) {
      best.push(o);
      if (best.length > 80) {
        best.sort((a, b) => scoreOption(a) - scoreOption(b));
        best.length = 55;
      }
    }

    await Promise.all(
      viaCodes.map((via) =>
        limitTrips(async () => {
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

                if (!Number.isFinite(transferMin) || transferMin < 0 || transferMin > MAX_TRANSFER) continue;

                const combo = combineOptions(optA, optB);
                if (combo) pushBest(combo);
              }
            })
          );
        })
      )
    );

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
   OVapi
   ========================= */
const ovLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 220,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/ov", ovLimiter);

// jouw haltecodes (Dordrecht Centraal Station perron A = 53600140)
const STATION_TO_TPC = {
  ddr: ["53600140"],
  ddzd: ["53608690"],
  rtb: ["31001125", "31008134"],
  rtd: ["31003941", "31001016", "31008000"],
  gvh: ["32003846"],
  gvc: ["32002609"],
};

const ovCache = new Map();
const OV_TTL_MS = 15 * 1000;

function ovCacheGet(key) {
  const hit = ovCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > OV_TTL_MS) {
    ovCache.delete(key);
    return null;
  }
  return hit.payload;
}
function ovCacheSet(key, payload) {
  ovCache.set(key, { t: Date.now(), payload });
}

async function fetchOvTpcSafe(tpc) {
  const url = `https://v0.ovapi.nl/tpc/${encodeURIComponent(tpc)}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await fetchJsonStrict(
        url,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "toepoels-planner/1.07",
          },
        },
        8000
      );
      return { ok: true, raw };
    } catch (e) {
      if (attempt === 2) return { ok: false, error: String(e?.message || e) };
    }
  }
  return { ok: false, error: "onbekend" };
}

function normalizeOvapi(tpc, dataRaw) {
  if (!dataRaw) return [];
  const root = dataRaw?.[String(tpc)];
  const stopName = root?.Stop?.Name || null;
  const passes = root?.Passes ? Object.values(root.Passes) : [];
  const items = [];

  for (const p of passes) {
    const line = p?.LinePublicNumber ?? p?.LineName ?? "";
    const dest = p?.DestinationName ?? "";
    const planned = p?.TargetDepartureTime ?? p?.PlannedDepartureTime ?? null;
    const expected = p?.ExpectedDepartureTime ?? planned ?? null;
    if (!expected) continue;

    const delayMin = (() => {
      const a = Date.parse(planned);
      const b = Date.parse(expected);
      if (!isFinite(a) || !isFinite(b)) return 0;
      return Math.max(0, Math.round((b - a) / 60000));
    })();

    items.push({
      tpc: String(tpc),
      stopName,
      line: String(line),
      destination: String(dest),
      plannedTime: planned,
      expectedTime: expected,
      delayMin,
      transportType: p?.TransportType || null,
      operator: p?.OperatorName || null,
    });
  }

  items.sort((a, b) => Date.parse(a.expectedTime) - Date.parse(b.expectedTime));
  return items;
}

app.get("/ov/by-station", async (req, res) => {
  const station = String(req.query.station || "").trim().toLowerCase();
  const tpcs = STATION_TO_TPC[station];

  if (!tpcs) return res.status(404).json({ error: "Station niet in OV mapping" });

  const key = `station:${station}`;
  const cached = ovCacheGet(key);
  if (cached) return res.json(cached);

  const settled = await Promise.all(
    tpcs.map(async (tpc) => {
      const r = await fetchOvTpcSafe(tpc);
      if (!r.ok) {
        return { tpc: String(tpc), stopName: null, passCount: 0, departures: [], error: r.error };
      }
      const raw = r.raw;
      const root = raw?.[String(tpc)];
      const stopName = root?.Stop?.Name || null;
      const passCount = root?.Passes ? Object.keys(root.Passes).length : 0;
      const deps = normalizeOvapi(tpc, raw);
      return { tpc: String(tpc), stopName, passCount, departures: deps, error: null };
    })
  );

  const merged = settled
    .map((x) => x.departures || [])
    .flat()
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.expectedTime) - Date.parse(b.expectedTime));

  const payload = {
    station,
    tpcs,
    perStop: settled,
    departures: merged.slice(0, 18),
  };

  ovCacheSet(key, payload);
  res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=20");
  res.json(payload);
});

/* =========================
   Start
   ========================= */
app.listen(PORT, () => {
  console.log(`✅ Server draait op http://localhost:${PORT} (PORT=${PORT})`);
});