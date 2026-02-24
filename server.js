// server.js — v1.15
// p-limit + rate limiting + caching + prefix fallback + slimme Extreme-B + OV (bus/tram/metro)
// + searchForArrival support + /reis returns { options } + sw.js no-cache for PWA updates

import dns from "dns";
dns.setDefaultResultOrder("ipv4first"); // ✅ Render/IPv6 issues

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
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
   - LET OP: sw.js NOOIT lang cachen (anders geen update-melding)
   ========================= */
app.use(
  express.static("public", {
    maxAge: "1h",
    etag: true,
    setHeaders: (res, path) => {
      // ✅ Service worker: altijd vers ophalen
      if (path.endsWith("/sw.js") || path.endsWith("\\sw.js")) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
      // (optioneel) manifest liever kort cachen
      if (path.endsWith("/manifest.json") || path.endsWith("\\manifest.json")) {
        res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      }
    },
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

/* ✅ OV endpoint limiter */
const ovLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/ov", ovLimiter);

/* =========================
   NS API
   ========================= */
const API_KEY = process.env.NS_API_KEY;
const headers = API_KEY ? { "Ocp-Apim-Subscription-Key": API_KEY, "Accept":"application/json", "User-Agent":"toepoels-planner/1.16" } : null;

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
   Health (handig voor debug)
   ========================= */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(API_KEY),
    node: process.version,
  });
});

/* =========================
   Snelle response caching (treinreizen)
   - Houd TTL kort zodat resultaten actueel blijven
   ========================= */
const tripCache = new Map();
const TRIP_TTL_MS = 20000;
function tripCacheGet(key) {
  const hit = tripCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > TRIP_TTL_MS) {
    tripCache.delete(key);
    return null;
  }
  return hit.payload;
}
function tripCacheSet(key, payload) {
  tripCache.set(key, { t: Date.now(), payload });
}


/* =========================
   Debug: test NS stations call
   ========================= */
app.get("/debug/ns-stations", async (req, res) => {
  res.setTimeout(15000);
  if (!requireApiKey(res)) return;
  const q = String(req.query.q || "rot").trim();
  try {
    const url = `https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/stations?q=${encodeURIComponent(q)}${API_KEY ? `&subscription-key=${encodeURIComponent(API_KEY)}` : ""}`;
    const r = await fetchWithTimeout(url, { headers }, 9000);
    const text = await r.text();
    res.status(200).type("application/json").send(JSON.stringify({ status: r.status, ok: r.ok, url, body: text.slice(0, 1200) }));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
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
   - TTL cache
   - prefix fallback
   - in-flight dedupe
   - cleanup to prevent memory growth
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

  // safety cap: verwijder oudste entries
  if (stationCache.size > STATION_MAX_KEYS) {
    const entries = Array.from(stationCache.entries()).sort((a, b) => a[1].t - b[1].t);
    const removeCount = stationCache.size - STATION_MAX_KEYS;
    for (let i = 0; i < removeCount; i++) stationCache.delete(entries[i][0]);
  }
}

function bestPrefixCached(key) {
  // zoek vanaf lang naar kort (min 2 chars)
  for (let i = key.length - 1; i >= 2; i--) {
    const pref = key.slice(0, i);
    const val = stationCacheGet(pref);
    if (val) return val;
  }
  return null;
}

// periodieke cleanup (tegen memory groei)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stationCache.entries()) {
    if (now - v.t > STATION_TTL_MS) stationCache.delete(k);
  }
}, 10 * 60 * 1000).unref();

async function fetchStationsFromNS(q) {
  const url = `https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/stations?q=${encodeURIComponent(q)}${API_KEY ? `&subscription-key=${encodeURIComponent(API_KEY)}` : ""}`;
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
  // voorkom “blijft laden”
  res.setTimeout(15000);
  if (!requireApiKey(res)) return;

  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);

  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

  const key = q.toLowerCase();

  try {
    const exact = stationCacheGet(key);

    // ✅ prefix fallback: direct antwoord met oudere prefix resultaten
    if (!exact) {
      const pref = bestPrefixCached(key);
      if (pref) {
        res.json(pref);
        // op achtergrond echte query ophalen
        fetchStationsCached(q).catch(() => {});
        return;
      }
    }

    const payload = exact || (await fetchStationsCached(q));
    res.json(payload);
  } catch (err) {
    console.error("Stations fout:", err?.message || err);
    res.status(502).json({ error: "Stations ophalen mislukt", detail: String(err?.message || err) });
  }
});

/* =========================
   TRIPS helpers
   ========================= */
async function fetchTrips({ from, to, dateTimeISO, extraParams = {} }) {
  const base = new URL("https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips");
  if (API_KEY) base.searchParams.set("subscription-key", API_KEY);
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

  // ✅ nooit negatieve overstap
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
   /reis (NORMAAL) — v1.08
   - return { options } zodat frontend hetzelfde kan renderen
   - ondersteunt searchForArrival=true/false
   ========================= */
app.get("/reis", async (req, res) => {
  if (!requireApiKey(res)) return;

  const { van, naar, datetime, searchForArrival } = req.query;
  if (!van || !naar || !datetime) return res.status(400).json({ error: "Parameters ontbreken" });

  const cacheKey = `reis:${String(van)}:${String(naar)}:${String(datetime)}:${String(searchForArrival ?? "")}`;
  const cached = tripCacheGet(cacheKey);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    return res.json(cached);
  }

  try {
    const extra = {
      ...(searchForArrival !== undefined ? { searchForArrival: String(searchForArrival) } : {}),
    };

    const data = await fetchTrips({
      from: String(van),
      to: String(naar),
      dateTimeISO: String(datetime),
      extraParams: extra,
    });

    const trips = Array.isArray(data.trips) ? data.trips : [];
    const options = trips.map(tripToOption).filter(Boolean);

    const payload = { options };
    tripCacheSet(cacheKey, payload);
    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    res.json(payload);
  } catch (err) {
    console.error("Reis fout:", err.message || err);
    res.status(500).json({ error: "Reis ophalen mislukt" });
  }
});

/* =========================
   /reis-extreme-b (SLIMMER) — v1.08
   - ondersteunt searchForArrival=true/false (base/A)
   - B leg zoekt altijd vanaf arrive-time (depart-based), dus searchForArrival=false
   ========================= */
app.get("/reis-extreme-b", async (req, res) => {
  if (!requireApiKey(res)) return;

  const { van, naar, datetime, searchForArrival } = req.query;
  if (!van || !naar || !datetime) return res.status(400).json({ error: "Parameters ontbreken" });

  const FROM = String(van);
  const TO = String(naar);
  const DT = String(datetime);

  const baseExtra = {
    ...EXTREME,
    ...(searchForArrival !== undefined ? { searchForArrival: String(searchForArrival) } : {}),
  };

  // Tunables
  const MAX_VIA = 8;
  const TOP_A = 5;
  const TOP_B = 8;
  const MAX_TRANSFER = 20; // 0..20 min
  const TARGET = 10;
  // Hard time budget: this endpoint must never take "forever".
  // If budget is exceeded we fall back to base results.
  const BUDGET_MS = 15000;
  const t0 = Date.now();

  function outOfTime() {
    return (Date.now() - t0) > BUDGET_MS;
  }

  function scoreOption(o) {
    const minT = o.minTransferMin ?? 999;
    const penalty = minT > 10 ? (minT - 10) * 2 : 0;
    return o.durationMin + penalty;
  }

  const cacheKey = `reisx:${FROM}:${TO}:${DT}:${String(searchForArrival ?? "")}`;
  const cached = tripCacheGet(cacheKey);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    return res.json(cached);
  }

  try {
    const base = await fetchTrips({
      from: FROM,
      to: TO,
      dateTimeISO: DT,
      extraParams: baseExtra,
    });

    const baseTrips = Array.isArray(base.trips) ? base.trips : [];
    const options = baseTrips.map(tripToOption).filter(Boolean);

    if (options.length >= TARGET) {
      options.sort((a, b) => scoreOption(a) - scoreOption(b));
      const payload = { options: options.slice(0, TARGET) };
      tripCacheSet(cacheKey, payload);
      res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
      return res.json(payload);
    }

    // via frequentie
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

    if (outOfTime()) {
      const payload = { options: options.slice(0, TARGET) };
      tripCacheSet(cacheKey, payload);
      res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
      return res.json(payload);
    }

    // resolve via codes (parallel)
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

    // combos verzamelen
    const best = [];
    function pushBest(o) {
      best.push(o);
      if (best.length > 80) {
        best.sort((a, b) => scoreOption(a) - scoreOption(b));
        best.length = 55;
      }
    }

    // Evaluate VIA combos with strict budget and limited concurrency.
    for (const via of viaCodes) {
      if (outOfTime()) break;

      await limitTrips(async () => {
        if (outOfTime()) return;

        // A: FROM -> VIA (respecteer searchForArrival keuze)
        const aData = await fetchTrips({
          from: FROM,
          to: via,
          dateTimeISO: DT,
          extraParams: baseExtra,
        });

        const aTrips = Array.isArray(aData.trips) ? aData.trips : [];
        const aOpts = aTrips
          .map(tripToOption)
          .filter(Boolean)
          .sort((x, y) => x.durationMin - y.durationMin)
          .slice(0, TOP_A);

        // Do NOT fan out unbounded Promise.all here; keep it capped and budget-aware.
        for (const optA of aOpts) {
          if (outOfTime()) break;

          await limitTrips(async () => {
            if (outOfTime()) return;

            // B: VIA -> TO zoekt vanaf optA.arrive
            const bData = await fetchTrips({
              from: via,
              to: TO,
              dateTimeISO: optA.arrive,
              extraParams: { ...EXTREME, searchForArrival: "false" },
            });

            const bTrips = Array.isArray(bData.trips) ? bData.trips : [];
            const bOpts = bTrips.map(tripToOption).filter(Boolean).slice(0, TOP_B);

            for (const optB of bOpts) {
              const transferMin = Math.round(
                (Date.parse(optB.depart) - Date.parse(optA.arrive)) / 60000
              );

              if (!Number.isFinite(transferMin) || transferMin < 0 || transferMin > MAX_TRANSFER)
                continue;

              const combo = combineOptions(optA, optB);
              if (combo) pushBest(combo);
            }
          });
        }
      });
    }

    // merge + dedupe + sort
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
    const payload = { options: deduped.slice(0, TARGET) };
    tripCacheSet(cacheKey, payload);
    res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=20");
    res.json(payload);
  } catch (err) {
    console.error("Extreme B fout:", err.message || err);
    res.status(500).json({ error: "Extreme B ophalen mislukt" });
  }
});

/* =========================
   OVapi (bus / tram / metro)
   - HTTPS is kapot (cert), dus fallback naar HTTP
   ========================= */

// Stations-config (gedeeld met frontend): public/stations.json
// De backend gebruikt alleen ov.mappings (code -> stopcodes)
const STATIONS_JSON_PATH = `./public/stations.1.16.json`;
const STATIONS_JSON_FALLBACK_PATH = "./public/stations.json";
const DEFAULT_STATIONS_CONFIG = {
  version: "1.16",
  ov: {
    mappings: {
      // Dordrecht
      ddr: { label: "OV stad", stops: ["53600140"] },
      ddr_streek: { label: "OV streek", stops: ["53600151", "53600160"] },
      ddzd: { label: "OV", stops: ["53608690"] },
      zwnd: { label: "OV", stops: ["53500260"] },

      // Den Haag
      gvh_tram: { label: "Tram", stops: ["2731", "2721", "2720", "2730"] },
      gvh_bus: { label: "Bus", stops: ["3847"] },
      gvc_tram: { label: "Tram", stops: ["2601", "2602", "2603", "2604"] },

      // Rotterdam
      rtd_tram: { label: "Tram", stops: ["HA1016", "HA1134", "HA1039", "HA1118", "HA1421"] },
      rtd_metro: { label: "Metro", stops: ["HA8700", "HA8000"] },
      rtd_bus: { label: "Bus", stops: ["HA3941", "HA3942", "HA3944"] },

      rtb_tram: { label: "Tram", stops: ["HA1125", "HA1312"] },
      rtb_metro: { label: "Metro", stops: ["HA8136", "HA8137"] },
    },
    stations: {
      dordrecht: ["ddr", "ddr_streek"],
      zwijndrecht: ["zwnd"],
      "den haag hs": ["gvh_tram", "gvh_bus"],
      "den haag centraal": ["gvc_tram"],
      "rotterdam centraal": ["rtd_tram", "rtd_metro", "rtd_bus"],
      "rotterdam blaak": ["rtb_tram", "rtb_metro"],
    },
  },
};

function loadStationsConfig() {
  try {
    const txt = fs.readFileSync(STATIONS_JSON_PATH, "utf-8");
    const parsed = JSON.parse(txt);
    if (parsed?.ov?.mappings && typeof parsed.ov.mappings === "object") return parsed;
  } catch {
    // ignore
  }
  return DEFAULT_STATIONS_CONFIG;
}

const STATIONS_CONFIG = loadStationsConfig();
const OV_MAPPINGS = STATIONS_CONFIG?.ov?.mappings || DEFAULT_STATIONS_CONFIG.ov.mappings;

const ovCache = new Map();
const OV_TTL_MS = 20000;

// Per-halte caching (scheelt veel OVAPI calls)
const ovCodeCache = new Map();
const OV_CODE_TTL_OK_MS = 15000;
const OV_CODE_TTL_ERR_MS = 5000;
function ovCodeCacheGet(key) {
  const hit = ovCodeCache.get(key);
  if (!hit) return null;
  const ttl = hit.ok ? OV_CODE_TTL_OK_MS : OV_CODE_TTL_ERR_MS;
  if (Date.now() - hit.t > ttl) {
    ovCodeCache.delete(key);
    return null;
  }
  return hit.payload;
}
function ovCodeCacheSet(key, payload, ok) {
  ovCodeCache.set(key, { t: Date.now(), payload, ok: Boolean(ok) });
}

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

async function fetchOvJsonSafe(path) {
  const urls = [
    `https://v0.ovapi.nl/${path}`, // (cert kan stuk, daarom ook http)
    `http://v0.ovapi.nl/${path}`,
  ];

  let lastErr = "onbekend";

  for (const url of urls) {
    try {
      const raw = await fetchJsonStrict(
        url,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "toepoels-planner/1.16",
          },
        },
        8000
      );
      return { ok: true, raw, usedUrl: url, status: 200 };
    } catch (e) {
      lastErr = `${url} -> ${String(e?.message || e)}`;
    }
  }

  return { ok: false, error: lastErr };
}

// Probeert een code als tpc; bij 404/geen data: slimme fallbacks
async function fetchOvForCode(code) {
  const c = String(code).trim();

  const cacheKey = `code:${c}`;
  const cached = ovCodeCacheGet(cacheKey);
  if (cached) return cached;

  // 1) Direct als tpc
  let r = await fetchOvJsonSafe(`tpc/${encodeURIComponent(c)}`);
  if (r.ok) {
    const payload = { ...r, kind: "tpc", requested: c, resolved: c };
    ovCodeCacheSet(cacheKey, payload, true);
    return payload;
  }

  // 2) Lokale numerieke haltecoden (bv. HTM 2604, 2731) werken bij OVAPI vaak als userstopcode
  if (/^\d{3,5}$/.test(c)) {
    const rUser = await fetchOvJsonSafe(`userstopcode/${encodeURIComponent(c)}`);
    if (rUser.ok) {
      const payload = { ...rUser, kind: "userstopcode", requested: c, resolved: c };
      ovCodeCacheSet(cacheKey, payload, true);
      return payload;
    }

    // fallback: sommige datasets gebruiken een 3200-prefix als tpc
    const padded = c.padStart(4, "0");
    const pref = `3200${padded}`;
    const r2 = await fetchOvJsonSafe(`tpc/${encodeURIComponent(pref)}`);
    if (r2.ok) {
      const payload = { ...r2, kind: "tpc", requested: c, resolved: pref };
      ovCodeCacheSet(cacheKey, payload, true);
      return payload;
    }
  }

  // 3) RET/Rotterdam codes zoals HA1016 zijn meestal lokale codes; OVAPI tpc is vaak 3100xxxx
  //    (bewijs: HA1125 ↔ 31001125, HA3941 ↔ 31003941)
  const haMatch = c.match(/^HA(\d{4})$/i);
  if (haMatch) {
    const pref = `3100${haMatch[1]}`;
    const r3 = await fetchOvJsonSafe(`tpc/${encodeURIComponent(pref)}`);
    if (r3.ok) {
      const payload = { ...r3, kind: "tpc", requested: c, resolved: pref };
      ovCodeCacheSet(cacheKey, payload, true);
      return payload;
    }
  }

  // 4) Codes met letters kunnen ook StopAreaCode zijn
  if (/[A-Za-z]/.test(c)) {
    const r4 = await fetchOvJsonSafe(`stopareacode/${encodeURIComponent(c)}`);
    if (r4.ok) {
      const payload = { ...r4, kind: "stopareacode", requested: c, resolved: c };
      ovCodeCacheSet(cacheKey, payload, true);
      return payload;
    }
  }


  // geef laatste fout terug (meestal van eerste attempt)
  const payload = { ok: false, error: r?.error || "OVAPI request failed", kind: "unknown", requested: c, resolved: null, usedUrl: r?.usedUrl || null, raw: null };
  ovCodeCacheSet(cacheKey, payload, false);
  return payload;
}

// Haal alle "stops" (objecten met Passes) uit een ovapi response (tpc of stopareacode)
function extractStopsFromOvapi(raw, primaryKey) {
  const out = [];

  if (!raw || typeof raw !== "object") return out;

  // tpc response: raw[tpc] = { Stop, Passes }
  const direct = raw?.[String(primaryKey)];
  if (direct && typeof direct === "object") {
    if (direct.Passes) out.push({ key: String(primaryKey), node: direct });

    // stopareacode response: raw[stopareacode] = { <tpc>: {Stop,Passes}, ... }
    for (const [k, v] of Object.entries(direct)) {
      if (v && typeof v === "object" && v.Passes) out.push({ key: String(k), node: v });
    }
  }

  // fallback: scan top-level
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object" && v.Passes) out.push({ key: String(k), node: v });
  }

  // dedupe op key
  const seen = new Set();
  return out.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)));
}

function pickDestination(p) {
  return (
    p?.DestinationName ??
    p?.DestinationName50 ??
    p?.DestinationName70 ??
    p?.DestinationName80 ??
    p?.Destination ??
    ""
  );
}

function normalizeOvapi(primaryKey, dataRaw) {
  const stops = extractStopsFromOvapi(dataRaw, primaryKey);
  if (!stops.length) return [];

  const items = [];

  for (const s of stops) {
    const stopName = s?.node?.Stop?.Name || null;
    const passes = s?.node?.Passes ? Object.values(s.node.Passes) : [];

    for (const p of passes) {
      const planned = p?.TargetDepartureTime ?? p?.PlannedDepartureTime ?? null;
      const expected = p?.ExpectedDepartureTime ?? planned ?? null;
      if (!expected) continue;

      items.push({
        tpc: String(s.key),
        stopName,
        line: p?.LinePublicNumber ?? p?.LineName ?? "",
        destination: pickDestination(p),
        plannedTime: planned,
        expectedTime: expected,
        transportType: p?.TransportType ?? null,
        operator: p?.OperatorName ?? null,
      });
    }
  }

  items.sort((a, b) => Date.parse(a.expectedTime) - Date.parse(b.expectedTime));
  return items;
}

// GET /ov/by-station?station=ddr
app.get("/ov/by-station", async (req, res) => {
  const stationRaw = String(req.query.station || "").trim();
  const stationKey = stationRaw.toLowerCase();

  // 1) mapping (case-insensitive) via stations.json
  let tpcs = OV_MAPPINGS?.[stationRaw]?.stops || OV_MAPPINGS?.[stationKey]?.stops;

  // 2) direct tpc list support: station=53600140,53600151
  if (!tpcs && stationRaw.includes(",")) {
    tpcs = stationRaw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  // 3) direct single tpc support
  if (!tpcs && stationRaw) {
    // alleen als het eruit ziet als een code (cijfers of letters+cijfers)
    if (/^[A-Za-z]*\d+[A-Za-z\d]*$/.test(stationRaw)) tpcs = [stationRaw];
  }

  if (!tpcs) {
    return res.status(404).json({
      error: "Station niet in OV mapping",
      hint: "Gebruik een bekende stationcode (bv. rtd_tram) of geef direct tpc(s) mee als station=53600140,53600151",
      knownStations: Object.keys(OV_MAPPINGS || {}).sort(),
    });
  }

  const key = `ov:${stationKey}:${tpcs.join(",")}`;
  const cached = ovCacheGet(key);
  if (cached) return res.json(cached);

  const perStop = await Promise.all(
    tpcs.map(async (code) => {
      const r = await fetchOvForCode(code);
      if (!r.ok) {
        return {
          requested: String(code),
          resolved: r.resolved,
          kind: r.kind,
          stopName: null,
          passCount: 0,
          departures: [],
          usedUrl: r.usedUrl,
          error: r.error,
        };
      }

      const raw = r.raw;
      const deps = normalizeOvapi(r.resolved || code, raw);

      // stopName + passCount: pak eerste stop die we kunnen vinden
      const stops = extractStopsFromOvapi(raw, r.resolved || code);
      const first = stops[0]?.node || null;
      const stopName = first?.Stop?.Name || null;
      const passCount = first?.Passes ? Object.keys(first.Passes).length : 0;

      return {
        requested: String(code),
        resolved: r.resolved,
        kind: r.kind,
        stopName,
        passCount,
        departures: deps,
        usedUrl: r.usedUrl,
        error: null,
      };
    })
  );

  const merged = perStop
    .flatMap((x) => x.departures || [])
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.expectedTime) - Date.parse(b.expectedTime));

  const payload = {
    station: stationKey,
    tpcs,
    perStop,
    departures: merged.slice(0, 25),
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
const APP_VERSION = "1.16";
;