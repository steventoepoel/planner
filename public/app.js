/* Toepoel's Reisplanner — app.js (v1.15)
   Fixes:
   - Geen JS parse errors (datum/tijd invullen + stations autocomplete werkt weer)
   - Logo linksboven = harde refresh (incl. SW + caches opruimen)
   - OV: stations.json config + caching + betere foutmeldingen + eindbestemming klein
   - Safari/iOS timezone parse fix voor OV + alle tijden
*/

(() => {
  "use strict";

  /* =========================
     VERSION
     ========================= */
  const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || "onbekend";
  const appVersionEl = document.getElementById("appVersion");
  if (appVersionEl) appVersionEl.textContent = APP_VERSION;

  /* =========================
     SAFARI TIME FIX
     Safari heeft moeite met timezone +0100 (zonder :)
     ========================= */
  function normalizeTZ(s){
    return String(s || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"); // +0100 -> +01:00
  }
  function safeParseTime(s){
    const x = normalizeTZ(s);
    const t = Date.parse(x);
    return Number.isFinite(t) ? t : NaN;
  }
  function safeDate(s){
    const t = safeParseTime(s);
    return Number.isFinite(t) ? new Date(t) : null;
  }

  /* =========================
     STORAGE MIGRATIE
     ========================= */
  const STORAGE_SCHEMA_KEY = "planner_storage_schema";
  const STORAGE_SCHEMA_CURRENT = 2; // v2 = favorieten met id + order

  function migrateStorageIfNeeded(){
    const raw = localStorage.getItem(STORAGE_SCHEMA_KEY);
    const current = Number(raw || 0);

    if (!current){
      // v1.07 -> v2 (planner_favorieten_v1 -> planner_favorieten_v2)
      const oldFavKey = "planner_favorieten_v1";
      const newFavKey = "planner_favorieten_v2";

      if (!localStorage.getItem(newFavKey) && localStorage.getItem(oldFavKey)){
        try{
          const old = JSON.parse(localStorage.getItem(oldFavKey) || "[]");
          const mapped = Array.isArray(old)
            ? old.map((f, idx)=>({
                id: String(Date.now()) + "_" + idx,
                van: String(f?.van || "").trim(),
                naar: String(f?.naar || "").trim()
              })).filter(x=>x.van && x.naar)
            : [];
          localStorage.setItem(newFavKey, JSON.stringify(mapped));
        } catch {}
      }

      localStorage.setItem(STORAGE_SCHEMA_KEY, String(STORAGE_SCHEMA_CURRENT));
      return;
    }

    if (current < STORAGE_SCHEMA_CURRENT){
      localStorage.setItem(STORAGE_SCHEMA_KEY, String(STORAGE_SCHEMA_CURRENT));
    }
  }
  migrateStorageIfNeeded();

  /* =========================
     HELPERS
     ========================= */
  function pad2(n){ return String(n).padStart(2,"0"); }
  function roundTo5Min(d){
    const x = new Date(d);
    x.setMinutes(Math.floor(x.getMinutes()/5)*5, 0, 0);
    return x;
  }
  function localISODate(d){
    const x = new Date(d);
    return `${x.getFullYear()}-${pad2(x.getMonth()+1)}-${pad2(x.getDate())}`;
  }
  function fmtTime(iso){
    const d = safeDate(iso);
    if (!d) return "—";
    return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  }
  function humanizeError(err){
    const msg = String(err?.message || err || "");

    if (msg.includes("Vertrek- en aankomststation mogen niet hetzelfde zijn"))
      return "⚠️ Je hebt hetzelfde station gekozen bij vertrek en aankomst.";

    if (!navigator.onLine) return "Je bent offline. Probeer later opnieuw.";
    if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) return "NS API key werkt niet (toegang geweigerd).";
    if (msg.includes("HTTP 500") || msg.includes("HTTP 502") || msg.includes("HTTP 503")) return "NS API is tijdelijk niet bereikbaar.";
    if (msg.includes("AbortError")) return "";
    return msg || "Er ging iets mis. Probeer opnieuw.";
  }

  async function fetchJson(url, options){
    const r = await fetch(url, options);
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const text = await r.text();

    let data = null;
    if (ct.includes("application/json")){
      try { data = JSON.parse(text); } catch {}
    }
    if (!r.ok){
      const errMsg = (data && (data.error || data.message)) ? (data.error || data.message) : `HTTP ${r.status}`;
      throw new Error(errMsg);
    }
    if (!data) throw new Error("Server gaf geen JSON terug");
    return data;
  }

  function debounce(fn, ms=200){
    let t=null;
    return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); };
  }

  function transferClass(min){
    if (min === null || min === undefined) return "";
    if (min < 1) return "bad";
    if (min < 3) return "ok";
    return "good";
  }

  function normName(x){ return (x||"").trim().toLowerCase(); }

  /* Normalize leg */
  function normLeg(l){
    const dep = l?.dep || l?.origin?.plannedDateTime || null;
    const arr = l?.arr || l?.destination?.plannedDateTime || null;

    const originName = l?.originName || l?.origin?.name || null;
    const destName   = l?.destName   || l?.destination?.name || null;

    const depTrack = l?.depTrack ?? l?.origin?.plannedTrack ?? "?";
    const arrTrack = l?.arrTrack ?? l?.destination?.plannedTrack ?? "?";

    const delayMin = l?.delayMin ?? l?.origin?.delayInMinutes ?? 0;

    const product =
      (typeof l?.product === "string" ? l.product : null) ||
      l?.product?.longCategoryName ||
      l?.product?.shortCategoryName ||
      l?.product?.categoryName ||
      "Trein";

    return { dep, arr, originName, destName, depTrack, arrTrack, delayMin, product };
  }

  function computeTransfersFromLegs(legs){
    const transfers = [];
    let minTransferMin = null;

    if (!Array.isArray(legs) || legs.length < 2) return { transfers, minTransferMin };

    const nlegs = legs.map(normLeg);
    for (let i=0; i<nlegs.length-1; i++){
      const a = nlegs[i];
      const b = nlegs[i+1];
      if (!a.arr || !b.dep) continue;

      const aT = safeParseTime(a.arr);
      const bT = safeParseTime(b.dep);
      if (!Number.isFinite(aT) || !Number.isFinite(bT)) continue;

      const m = Math.round((bT - aT)/60000);
      const station = a.destName || "Overstap";

      if (m < 0) continue;

      transfers.push({ station, minutes: m });
      if (minTransferMin === null || m < minTransferMin) minTransferMin = m;
    }
    return { transfers, minTransferMin };
  }

  function sortByStartTime(arr){
    return arr.sort((a,b)=> safeParseTime(a.depart) - safeParseTime(b.depart));
  }

  /* Fallback: NS trips -> options (als /reis direct trips teruggeeft) */
  function tripToOptionFromNS(trip){
    const legs = Array.isArray(trip?.legs) ? trip.legs : [];
    if (!legs.length) return null;

    const depart = legs[0]?.origin?.plannedDateTime || null;
    const arrive = legs[legs.length - 1]?.destination?.plannedDateTime || null;
    if (!depart || !arrive) return null;

    const depT = safeParseTime(depart);
    const arrT = safeParseTime(arrive);
    if (!Number.isFinite(depT) || !Number.isFinite(arrT)) return null;

    const durationMin = Math.round((arrT - depT)/60000);

    const mappedLegs = legs.map(l => ({
      originName: l.origin?.name,
      destName: l.destination?.name,
      dep: l.origin?.plannedDateTime,
      arr: l.destination?.plannedDateTime,
      depTrack: l.origin?.plannedTrack ?? "?",
      arrTrack: l.destination?.plannedTrack ?? "?",
      delayMin: l.origin?.delayInMinutes ?? 0,
      product: l.product?.longCategoryName || l.product?.shortCategoryName || "Trein"
    }));

    return { durationMin, depart, arrive, legs: mappedLegs };
  }

  /* =========================
     STATE KEYS
     ========================= */
  const LS = {
    van:"last_van",
    naar:"last_naar",
    mode:"planner_mode",            // "extreme" | "normal"
    searchType:"planner_searchType" // "depart" | "arrive"
  };

  /* =========================
     ELEMENTS
     ========================= */
  const vanInput = document.getElementById("van");
  const naarInput = document.getElementById("naar");
  const stationsVan = document.getElementById("stationsVan");
  const stationsNaar = document.getElementById("stationsNaar");
  const dateInput = document.getElementById("dateInput");
  const hourSelect = document.getElementById("hourSelect");
  const minuteSelect = document.getElementById("minuteSelect");
  const wisselBtnIcon = document.getElementById("wisselBtnIcon");
  const zoekBtn = document.getElementById("zoekBtn");
  const favBtn = document.getElementById("favBtn");
  const favDiv = document.getElementById("favorieten");
  const resultaat = document.getElementById("resultaat");
  const humanErrorEl = document.getElementById("humanError");
  const vanHint = document.getElementById("vanHint");
  const naarHint = document.getElementById("naarHint");
  const searchTypeEl = document.getElementById("searchType");
  const modeNormalBtn = document.getElementById("modeNormal");
  const modeExtremeBtn = document.getElementById("modeExtreme");
  const logoRefreshBtn = document.getElementById("logoRefreshBtn");

  if (!vanInput || !naarInput || !stationsVan || !stationsNaar || !dateInput || !hourSelect || !minuteSelect){
    console.error("Ontbrekende DOM elementen. Controleer index.html ids.");
    return;
  }

  /* =========================
     HARD REFRESH (logo)
     ========================= */
  async function hardRefresh(){
    try{
      // unregister SW
      if ("serviceWorker" in navigator){
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister().catch(()=>{})));
      }
      // clear caches
      if (window.caches?.keys){
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k).catch(()=>{})));
      }
    } catch {}
    // cache-bust reload
    const u = new URL(location.href);
    u.searchParams.set("v", String(Date.now()));
    location.replace(u.toString());
  }
  logoRefreshBtn?.addEventListener("click", hardRefresh);

  /* =========================
     MOBILE: keyboard dismiss
     ========================= */
  function dismissKeyboard(){
    document.activeElement?.blur?.();
  }
  document.addEventListener("touchstart", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.closest?.("button"))) return;
    dismissKeyboard();
  }, { passive:true });
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.closest?.("button"))) return;
    dismissKeyboard();
  });

  /* date fully clickable */
  dateInput.addEventListener("click", ()=>{
    if (dateInput.showPicker) dateInput.showPicker();
    else dateInput.focus();
  });

  /* fill time selects */
  hourSelect.innerHTML = "";
  minuteSelect.innerHTML = "";
  for(let h=0; h<24; h++){
    const o=document.createElement("option");
    o.value=pad2(h); o.textContent=pad2(h);
    hourSelect.appendChild(o);
  }
  for(let m=0; m<60; m+=5){
    const o=document.createElement("option");
    o.value=pad2(m); o.textContent=pad2(m);
    minuteSelect.appendChild(o);
  }

  /* load saved inputs */
  vanInput.value = localStorage.getItem(LS.van) || "";
  naarInput.value = localStorage.getItem(LS.naar) || "";

  /* ✅ Datum/tijd bij start altijd NU */
  const now = roundTo5Min(new Date());
  dateInput.value = localISODate(now);
  hourSelect.value = pad2(now.getHours());
  minuteSelect.value = pad2(now.getMinutes());

  /* search type restore */
  if (searchTypeEl){
    searchTypeEl.value = localStorage.getItem(LS.searchType) || "depart";
    searchTypeEl.addEventListener("change", ()=> localStorage.setItem(LS.searchType, searchTypeEl.value));
  }

  function persistStations(){
    localStorage.setItem(LS.van, vanInput.value);
    localStorage.setItem(LS.naar, naarInput.value);
  }
  ["input","change"].forEach(evt=>{
    vanInput.addEventListener(evt, persistStations);
    naarInput.addEventListener(evt, persistStations);
  });

  /* click-to-clear stations */
  function clearOnClick(el, key){
    el.addEventListener("click", ()=>{
      if (el.value.trim()) {
        el.value = "";
        localStorage.setItem(key,"");
      }
    });
  }
  clearOnClick(vanInput, LS.van);
  clearOnClick(naarInput, LS.naar);

  /* =========================
     MODE (standaard extreme)
     + ondersteunt ?mode=normal/extreme
     ========================= */
  function setMode(mode){
    const m = (mode === "normal") ? "normal" : "extreme";
    localStorage.setItem(LS.mode, m);

    modeNormalBtn?.classList.toggle("active", m === "normal");
    modeExtremeBtn?.classList.toggle("active", m === "extreme");

    const hc = document.querySelector(".headerControls");
    if (hc) hc.textContent = (m === "extreme") ? "⚡ Extra korte overstappen" : "✅ Normale overstappen";
  }

  (function initMode(){
    const urlMode = new URLSearchParams(location.search).get("mode");
    if (urlMode === "normal" || urlMode === "extreme"){
      setMode(urlMode);
      return;
    }
    setMode(localStorage.getItem(LS.mode) || "extreme");
  })();

  modeNormalBtn?.addEventListener("click", ()=> setMode("normal"));
  modeExtremeBtn?.addEventListener("click", ()=> setMode("extreme"));

  /* =========================
     AUTOCOMPLETE (min 2 letters)
     ========================= */
  let vanList = [];
  let naarList = [];
  const stationCache = new Map(); // key: which:query -> array
  let stationAbortVan = null;
  let stationAbortNaar = null;

  function setHint(which, text){
    if (which === "van" && vanHint) vanHint.textContent = text || "";
    if (which === "naar" && naarHint) naarHint.textContent = text || "";
  }

  async function loadStations(q, listEl, store, which){
    const query = (q || "").trim();
    if (query.length < 2) {
      listEl.innerHTML = "";
      store.length = 0;
      setHint(which, query.length ? "Typ minimaal 2 letters voor suggesties." : "");
      return;
    }

    setHint(which, "");

    const key = (which + ":" + query.toLowerCase());
    if (stationCache.has(key)){
      const data = stationCache.get(key) || [];
      listEl.innerHTML = "";
      store.length = 0;
      data.forEach(s=>{
        const opt=document.createElement("option");
        opt.value = s.namen.lang;
        listEl.appendChild(opt);
        store.push(s);
      });
      return;
    }

    if (which === "van"){
      if (stationAbortVan) stationAbortVan.abort();
      stationAbortVan = new AbortController();
    } else {
      if (stationAbortNaar) stationAbortNaar.abort();
      stationAbortNaar = new AbortController();
    }
    const signal = (which === "van") ? stationAbortVan.signal : stationAbortNaar.signal;

    const data = await fetchJson(`/stations?q=${encodeURIComponent(query)}`, { signal });
    stationCache.set(key, data || []);

    listEl.innerHTML = "";
    store.length = 0;
    (data||[]).forEach(s=>{
      const opt=document.createElement("option");
      opt.value = s.namen.lang;
      listEl.appendChild(opt);
      store.push(s);
    });

    if (!store.length){
      setHint(which, "Geen stations gevonden. Controleer spelling.");
    }
  }

  vanInput.addEventListener("input", debounce(()=>loadStations(vanInput.value, stationsVan, vanList, "van"), 200));
  naarInput.addEventListener("input", debounce(()=>loadStations(naarInput.value, stationsNaar, naarList, "naar"), 200));

  async function resolveCode(name, store, which){
    const wanted = normName(name);

    const hit = store.find(s=> normName(s.namen.lang) === wanted);
    if (hit) return hit.code;

    for (const arr of stationCache.values()){
      const ex = (arr||[]).find(s=> normName(s.namen.lang) === wanted);
      if (ex) return ex.code;
    }

    if (String(name||"").trim().length < 2){
      setHint(which, "Typ minimaal 2 letters en kies een suggestie.");
      return null;
    }

    const data = await fetchJson(`/stations?q=${encodeURIComponent(name)}`);
    const exact = (data||[]).find(s=> normName(s.namen.lang) === wanted);

    if (!exact){
      setHint(which, "Kies een station uit de lijst (klik op een suggestie).");
      return null;
    }
    return exact.code;
  }

  function validateStationInput(el, store, which){
    const val = el.value.trim();
    if (!val) { setHint(which, ""); return; }
    const wanted = normName(val);
    const exactInStore = store.some(s=> normName(s.namen.lang) === wanted);
    if (!exactInStore){
      setHint(which, "Kies een station uit de lijst (klik op een suggestie).");
    } else {
      setHint(which, "");
    }
  }
  vanInput.addEventListener("blur", ()=>validateStationInput(vanInput, vanList, "van"));
  naarInput.addEventListener("blur", ()=>validateStationInput(naarInput, naarList, "naar"));

  function buildDateTime(){
    return `${dateInput.value}T${hourSelect.value}:${minuteSelect.value}`;
  }

  /* Wissel (icoon) */
  wisselBtnIcon?.addEventListener("click", ()=>{
    const t = vanInput.value;
    vanInput.value = naarInput.value;
    naarInput.value = t;
    persistStations();
  });

  /* =========================
     OV helpers — multi buttons per station
     - Laad stations.json (gedeeld met backend)
     ========================= */

  const OV_BUTTONS_BY_STATION = new Map();

  // Fallback (als stations.json niet laadt)
  const OV_BUTTONS_FALLBACK = new Map([
    ["dordrecht", [
      { label: "OV stad",   code: "ddr" },
      { label: "OV streek", code: "ddr_streek" },
    ]],
    ["zwijndrecht", [
      { label: "OV", code: "zwnd" },
    ]],
    ["den haag hs", [
      { label: "Tram", code: "gvh_tram" },
      { label: "Bus",  code: "gvh_bus"  },
    ]],
    ["den haag centraal", [
      { label: "Tram", code: "gvc_tram" },
    ]],
    ["rotterdam centraal", [
      { label: "Tram",  code: "rtd_tram"  },
      { label: "Metro", code: "rtd_metro" },
      { label: "Bus",   code: "rtd_bus"   },
    ]],
    ["rotterdam blaak", [
      { label: "Tram",  code: "rtb_tram"  },
      { label: "Metro", code: "rtb_metro" },
    ]],
  ]);

  async function loadStationsConfig(){
    try{
      const cfg = await fetchJson(`/stations.json?v=${encodeURIComponent(APP_VERSION)}&t=${Date.now()}`);
      const stations = cfg?.ov?.stations;
      const mappings = cfg?.ov?.mappings;
      if (!stations || !mappings) throw new Error("stations.json mist ov.stations of ov.mappings");

      OV_BUTTONS_BY_STATION.clear();
      Object.entries(stations).forEach(([stationKey, codes])=>{
        const key = normName(stationKey);
        const btns = (Array.isArray(codes) ? codes : []).map(code=>{
          const m = mappings?.[code];
          return { label: (m?.label || code), code };
        });
        OV_BUTTONS_BY_STATION.set(key, btns);
      });
    } catch(e){
      // stil falen: we hebben fallback
      // console.warn("stations.json laden mislukt", e);
    }
  }

  // Laad config op de achtergrond (mag de treinsearch niet blokkeren)
  loadStationsConfig();

  function getOvButtonsForStation(stationName){
    const key = normName(stationName || "");
    return OV_BUTTONS_BY_STATION.get(key) || OV_BUTTONS_FALLBACK.get(key) || [];
  }

  function classifyOvTransfer(min){
    if (!Number.isFinite(min)) return "";
    if (min < 3) return "bad";
    if (min < 6) return "ok";
    return "good";
  }

  function ovIcon(type){
    const t = String(type || "").toUpperCase();
    if (t.includes("METRO")) return "🚇";
    if (t.includes("TRAM")) return "🚋";
    return "🚌";
  }

  function renderOvPanel(panelEl, title, ovData, trainArrIso){
    panelEl.innerHTML = "";

    const head = document.createElement("div");
    head.style.fontWeight = "900";
    head.textContent = title;
    panelEl.appendChild(head);

    const trainArrT = safeParseTime(trainArrIso || "");
    const deps = Array.isArray(ovData?.departures) ? ovData.departures : [];
    const perStop = Array.isArray(ovData?.perStop) ? ovData.perStop : [];

    let shown = 0;

    // Gezonde foutmelding als OVAPI niets teruggeeft (of haltes fout zijn)
    if (!deps.length){
      const anyErr = perStop.some(s => s && s.error);
      const anyOk  = perStop.some(s => s && !s.error);
      const msg = document.createElement("div");
      msg.className = "small";
      msg.style.marginTop = "6px";
      if (anyErr && !anyOk) msg.textContent = "Geen live-vertrektijden beschikbaar (OVAPI/haltecode probleem).";
      else msg.textContent = "Geen OV-vertrektijden gevonden.";
      panelEl.appendChild(msg);
    }

    const within = [];
    const after = [];

    deps.slice(0, 80).forEach(d => {
      const depIso = d.expectedTime || d.plannedTime;
      const depT = safeParseTime(depIso || "");
      if (!Number.isFinite(depT) || !Number.isFinite(trainArrT)) return;

      const transferMin = Math.round((depT - trainArrT) / 60000);
      if (transferMin < 0) return;

      const item = { d, depIso, transferMin };

      // primair: 0..30 min na aankomst
      if (transferMin <= 30) within.push(item);
      else if (transferMin <= 120) after.push(item); // fallback: toon eerstvolgende opties tot 2 uur
    });

    function addRow(item){
      const { d, depIso, transferMin } = item;

      shown++;

      const row = document.createElement("div");
      row.className = "ovItem";

      const main = document.createElement("div");
      main.className = "ovMain";

      const left = document.createElement("div");
      left.className = "ovLeft";
      left.textContent = `${ovIcon(d.transportType)} ${d.line || ""}`.trim();

      const mid = document.createElement("div");
      mid.className = "ovMid";
      // heel klein de eindbestemming (d.destination)
      mid.textContent = d.destination ? `→ ${d.destination}` : (d.stopName ? `→ ${d.stopName}` : "");

      const right = document.createElement("div");
      right.className = "ovRight";
      right.textContent = fmtTime(depIso);

      const badge = document.createElement("span");
      badge.className = `ovTransfer ${classifyOvTransfer(transferMin)}`;
      badge.textContent = `${transferMin}m`;

      main.appendChild(left);
      main.appendChild(mid);

      row.appendChild(main);
      row.appendChild(right);
      row.appendChild(badge);

      panelEl.appendChild(row);
    }

    within.slice(0, 25).forEach(addRow);

    // fallback: als er wel vertrektijden zijn maar niets binnen 30 min, toon volgende 8 (tot 120 min)
    if (within.length === 0 && after.length > 0){
      const note = document.createElement("div");
      note.className = "small";
      note.style.marginTop = "6px";
      note.textContent = "Er zijn wel OV-vertrektijden, maar geen binnen 30 minuten na aankomst van de trein (filter 0–30 min). Hieronder de eerstvolgende opties:";
      panelEl.appendChild(note);

      after.slice(0, 8).forEach(addRow);
    }

    if (shown === 0){
      const msg = document.createElement("div");
      msg.className = "small";
      msg.style.marginTop = "6px";
      msg.textContent = "Geen haalbare OV-vertrektijden binnen 30 minuten na aankomst van de trein.";
      panelEl.appendChild(msg);
    }

    const foot = document.createElement("div");
    foot.className = "small";
    foot.style.marginTop = "8px";
    foot.innerHTML = `Trein aankomst: <b>${fmtTime(trainArrIso)}</b><br>OV filter: 0–30 min`;
    panelEl.appendChild(foot);
  }

  async function loadOv(panelEl, stationCode, title, trainArrIso){
    panelEl.innerHTML = `<div class="small">Laden…</div>`;
    try{
      const url = `/ov/by-station?station=${encodeURIComponent(stationCode)}&v=${encodeURIComponent(APP_VERSION)}&t=${Date.now()}`;
      const data = await fetchJson(url);
      renderOvPanel(panelEl, title, data, trainArrIso);
    } catch(e){
      panelEl.innerHTML = `<div class="small">${humanizeError(e)}</div>`;
    }
  }

  /* =========================
     TRIP UI (expand)
     ========================= */
  function renderExpandableTrip(opt){
    const card = document.createElement("div");
    card.className = "resultCard";

    const depart = opt.depart;
    const arrive = opt.arrive;
    const durationMin = opt.durationMin;
    const legs = opt.legs || [];
    const transfersCount = Math.max(0, legs.length - 1);

    const transfersInfo = opt.transfersInfo || computeTransfersFromLegs(legs);
    const transfers = transfersInfo.transfers || [];
    const minTransferMin = transfersInfo.minTransferMin ?? null;
    const minCls = transferClass(minTransferMin);

    const header = document.createElement("div");
    header.className = "resultHeader";
    header.innerHTML = `
      <div class="resultHeaderLeft">
        <div class="tripTitle">Totale reistijd: ${durationMin} min</div>
        <div class="timeBig"><span>${fmtTime(depart)}</span> → <span>${fmtTime(arrive)}</span></div>
        <div class="badgeRow">
          <span class="badge">Overstappen: ${transfersCount}</span>
          ${minTransferMin !== null ? `<span class="badge ${minCls}">Min overstap: ${minTransferMin} min</span>` : ""}
        </div>
      </div>
      <div class="chev">▾</div>
    `;

    const details = document.createElement("div");
    details.className = "details";

    let built = false;
    function buildDetails(){
      if (built) return;
      built = true;

      if (minTransferMin !== null && minTransferMin < 3) {
        const w = document.createElement("div");
        w.className = "warn";
        w.textContent = `⚠️ Korte overstaptijd: minimaal ${minTransferMin} minuten.`;
        details.appendChild(w);
      }

      if (transfers.length){
        const tl = document.createElement("div");
        tl.className = "transferList";
        tl.innerHTML = `<b>Overstappen</b>`;
        transfers.forEach(t=>{
          const item = document.createElement("div");
          item.className = "transferItem";
          item.innerHTML = `
            <div class="transferLeft">${t.station}</div>
            <div class="transferRight ${transferClass(t.minutes)}">${t.minutes} min</div>
          `;
          tl.appendChild(item);
        });
        details.appendChild(tl);
      }

      const hr = document.createElement("div");
      hr.className = "hr";
      details.appendChild(hr);

      // Per trip: maar 1 OV paneel open tegelijk
      let openPanel = null;

      legs.forEach((l, idx)=>{
        const x = normLeg(l);

        const legEl = document.createElement("div");
        legEl.className = "leg";

        const legTop = document.createElement("div");
        legTop.className = "legTop";
        legTop.innerHTML = `
          <div>🚆 ${x.product}</div>
          <div>${fmtTime(x.dep)} → ${fmtTime(x.arr)}</div>
        `;

        const legLine = document.createElement("div");
        legLine.className = "legLine";
        legLine.innerHTML = `
          ${x.originName || "—"} (spoor ${x.depTrack ?? "?"}) → ${x.destName || "—"} (spoor ${x.arrTrack ?? "?"})
          ${x.delayMin > 0 ? `<span class="delay"> +${x.delayMin} min</span>` : ""}
        `;

        // OV knoppen alleen bij aankomststation van deze leg
        const ovButtons = (x.arr && x.destName) ? getOvButtonsForStation(x.destName) : [];
        if (ovButtons.length){
          const btnWrap = document.createElement("span");
          btnWrap.style.display = "inline-flex";
          btnWrap.style.gap = "8px";
          btnWrap.style.marginLeft = "10px";
          btnWrap.style.flexWrap = "wrap";

          const panel = document.createElement("div");
          panel.className = "ovPanel";
          panel.style.display = "none";
          legEl.appendChild(panel);

          ovButtons.forEach(({label, code})=>{
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "ovBtn";
            btn.textContent = label || "OV";
            btnWrap.appendChild(btn);

            btn.addEventListener("click", async (e)=>{
              e.stopPropagation();

              if (openPanel && openPanel !== panel){
                openPanel.style.display = "none";
                openPanel.innerHTML = "";
              }

              panel.style.display = "block";
              openPanel = panel;

              await loadOv(panel, code, `Live ${btn.textContent} bij ${x.destName}`, x.arr);
            });
          });

          legLine.appendChild(btnWrap);
        }

        legEl.appendChild(legTop);
        legEl.appendChild(legLine);
        details.appendChild(legEl);

        if (idx < legs.length - 1) {
          const hr2 = document.createElement("div");
          hr2.className = "hr";
          details.appendChild(hr2);
        }
      });
    }

    header.addEventListener("click", ()=>{
      const willOpen = !details.classList.contains("open");
      if (willOpen) buildDetails();
      const isOpen = details.classList.toggle("open");
      header.querySelector(".chev").textContent = isOpen ? "▴" : "▾";
    });

    card.appendChild(header);
    card.appendChild(details);
    return card;
  }

  /* =========================
     SEARCH
     ========================= */
  const EXTREME_ENDPOINT = "/reis-extreme-b";
  const NORMAL_ENDPOINT  = "/reis";
  let inFlightSearch = null;

  function getMode(){
    return localStorage.getItem(LS.mode) === "normal" ? "normal" : "extreme";
  }

  async function zoekReis(){
    if (!zoekBtn) return;

    humanErrorEl.textContent = "";
    resultaat.innerHTML = "";

    if (vanInput.value.trim().toLowerCase() === naarInput.value.trim().toLowerCase()) {
      humanErrorEl.textContent = "⚠️ Je hebt hetzelfde station gekozen bij vertrek en aankomst.";
      return;
    }

    if (inFlightSearch) inFlightSearch.abort();
    inFlightSearch = new AbortController();
    const signal = inFlightSearch.signal;

    try{
      const vanName = vanInput.value.trim();
      const naarName = naarInput.value.trim();
      const dt = buildDateTime();
      const searchType = searchTypeEl ? searchTypeEl.value : "depart";
      const searchForArrival = (searchType === "arrive");

      if (!vanName || !naarName) { humanErrorEl.textContent = "Vul van en naar in."; return; }
      if (!dt) { humanErrorEl.textContent = "Kies datum/tijd."; return; }

      zoekBtn.disabled = true;
      zoekBtn.textContent = "Zoeken…";

      const [vanCode, naarCode] = await Promise.all([
        resolveCode(vanName, vanList, "van"),
        resolveCode(naarName, naarList, "naar")
      ]);

      if (!vanCode || !naarCode) {
        humanErrorEl.textContent = "⚠️ Kies stations uit de lijst (klik op een suggestie).";
        return;
      }

      const endpoint = (getMode() === "normal") ? NORMAL_ENDPOINT : EXTREME_ENDPOINT;

      const url =
        `${endpoint}?van=${encodeURIComponent(vanCode)}&naar=${encodeURIComponent(naarCode)}&datetime=${encodeURIComponent(dt)}&searchForArrival=${encodeURIComponent(String(searchForArrival))}`;

      const data = await fetchJson(url, { signal });

      let opts = Array.isArray(data?.options) ? data.options : null;
      if (!opts && Array.isArray(data?.trips)){
        opts = data.trips.map(tripToOptionFromNS).filter(Boolean);
      }
      if (!Array.isArray(opts)) opts = [];

      if (!opts.length) {
        resultaat.innerHTML = `<div class="resultCard">Geen opties gevonden.</div>`;
        return;
      }

      opts.forEach(o=>{
        o.transfersInfo = o.transfersInfo || computeTransfersFromLegs(o.legs || []);
      });

      const frag = document.createDocumentFragment();
      sortByStartTime(opts).forEach(o=>{
        frag.appendChild(renderExpandableTrip(o));
      });
      resultaat.appendChild(frag);

    } catch(e){
      const msg = humanizeError(e);
      if (msg) {
        humanErrorEl.textContent = msg;
        resultaat.innerHTML = `<div class="resultCard">${msg}</div>`;
      }
    } finally{
      zoekBtn.disabled = false;
      zoekBtn.textContent = "Zoek reis";
    }
  }

  /* Enter = zoeken */
  [vanInput, naarInput, dateInput, hourSelect, minuteSelect, searchTypeEl].filter(Boolean).forEach(el=>{
    el.addEventListener("keydown",(e)=>{
      if (e.key==="Enter"){ e.preventDefault(); zoekReis(); }
    });
  });
  zoekBtn?.addEventListener("click", zoekReis);

  /* =========================
     FAVORIETEN (LOCALSTORAGE v2) + SLEPEN/SORTEREN
     ========================= */
  const FAV_KEY = "planner_favorieten_v2";

  function getFavs() {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function saveFavs(favs) {
    localStorage.setItem(FAV_KEY, JSON.stringify(favs));
  }
  function moveItem(arr, from, to){
    const a = arr.slice();
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x);
    return a;
  }
  let dragIndex = null;

  function laadFavorieten() {
    if (!favDiv) return;
    const favs = getFavs();
    favDiv.innerHTML = "";

    if (!favs.length) {
      favDiv.innerHTML = `<div class="small">Nog geen favoriete reizen.</div>`;
      return;
    }

    const frag = document.createDocumentFragment();

    favs.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "favitem";
      row.draggable = true;
      row.dataset.index = String(i);

      row.addEventListener("dragstart", (e)=>{
        dragIndex = i;
        try { e.dataTransfer.setData("text/plain", String(i)); } catch {}
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragover", (e)=>{
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("drop", (e)=>{
        e.preventDefault();
        const from = (dragIndex !== null) ? dragIndex : Number(e.dataTransfer.getData("text/plain"));
        const to = i;
        if (!Number.isFinite(from) || from === to) return;

        const updated = moveItem(getFavs(), from, to);
        saveFavs(updated);
        laadFavorieten();
      });

      const left = document.createElement("div");
      left.className = "favLeft";

      const grip = document.createElement("div");
      grip.className = "favGrip";
      grip.title = "Sleep om te sorteren";
      grip.textContent = "⠿";

      const name = document.createElement("div");
      name.className = "favName";
      name.textContent = `${f.van} → ${f.naar}`;
      name.onclick = () => {
        vanInput.value = f.van;
        naarInput.value = f.naar;
        persistStations();
        dismissKeyboard();
        window.scrollTo({ top: 0, behavior: "smooth" });
      };

      left.appendChild(grip);
      left.appendChild(name);

      const right = document.createElement("div");
      right.className = "favRight";

      // alleen delete (pijltjes overbodig op mobiel; CSS kan ze ook verbergen)
      const del = document.createElement("button");
      del.className = "favDel";
      del.type = "button";
      del.textContent = "✖";
      del.onclick = () => {
        const updated = getFavs();
        updated.splice(i, 1);
        saveFavs(updated);
        laadFavorieten();
      };

      right.appendChild(del);

      row.appendChild(left);
      row.appendChild(right);

      frag.appendChild(row);
    });

    favDiv.appendChild(frag);
  }

  favBtn?.addEventListener("click", () => {
    const van = vanInput.value.trim();
    const naar = naarInput.value.trim();
    if (!van || !naar) { alert("Vul van en naar in."); return; }

    const favs = getFavs();
    const exists = favs.some(f =>
      String(f.van).toLowerCase() === van.toLowerCase() &&
      String(f.naar).toLowerCase() === naar.toLowerCase()
    );
    if (exists) { alert("Deze favoriete reis bestaat al."); return; }

    favs.push({ id: String(Date.now()), van, naar });
    saveFavs(favs);
    laadFavorieten();

    const old = favBtn.textContent;
    favBtn.textContent = "✅ Opgeslagen";
    setTimeout(()=>{ favBtn.textContent = old; }, 900);
  });

  laadFavorieten();

  /* =========================
     PWA: update-melding + herladen
     ========================= */
  const updateBanner = document.getElementById("updateBanner");
  const reloadBtn = document.getElementById("reloadBtn");
  let swReg = null;

  function showUpdateBanner(){ if (updateBanner) updateBanner.style.display = "block"; }
  function hideUpdateBanner(){ if (updateBanner) updateBanner.style.display = "none"; }

  reloadBtn?.addEventListener("click", async ()=>{
    if (swReg?.waiting){
      try{ swReg.waiting.postMessage({ type: "SKIP_WAITING" }); } catch {}
    } else {
      location.reload();
    }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").then((reg)=>{
      swReg = reg;
      if (reg.waiting) showUpdateBanner();

      reg.addEventListener("updatefound", ()=>{
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", ()=>{
          if (newWorker.state === "installed" && navigator.serviceWorker.controller){
            showUpdateBanner();
          }
        });
      });
    }).catch(()=>{});

    navigator.serviceWorker.addEventListener("controllerchange", ()=>{
      hideUpdateBanner();
      location.reload();
    });
  }

  console.log("Toepoel's Planner app.js loaded", APP_VERSION);
})();
