/* Toepoel's Reisplanner — app.js (v1.09) */

/* =========================
   VERSION + STORAGE MIGRATIE
   ========================= */
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || "onbekend";
document.getElementById("appVersion").textContent = APP_VERSION;

/* storage schema */
const STORAGE_SCHEMA_KEY = "planner_storage_schema";
const STORAGE_SCHEMA_CURRENT = 2; // v2 = favorieten met id + order

function migrateStorageIfNeeded(){
  const raw = localStorage.getItem(STORAGE_SCHEMA_KEY);
  const current = Number(raw || 0);

  if (!current){
    // v1.07: planner_favorieten_v1 = [{van,naar}]
    const oldFavKey = "planner_favorieten_v1";
    const newFavKey = "planner_favorieten_v2";

    if (!localStorage.getItem(newFavKey) && localStorage.getItem(oldFavKey)){
      try{
        const old = JSON.parse(localStorage.getItem(oldFavKey) || "[]");
        const mapped = Array.isArray(old) ? old.map((f, idx)=>({
          id: String(Date.now()) + "_" + idx,
          van: String(f?.van || "").trim(),
          naar: String(f?.naar || "").trim()
        })).filter(x=>x.van && x.naar) : [];
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

/* ------------ helpers ------------ */
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
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}
function humanizeError(err){
  const msg = String(err || "");

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

    const aT = Date.parse(a.arr);
    const bT = Date.parse(b.dep);
    if (!isFinite(aT) || !isFinite(bT)) continue;

    const m = Math.round((bT - aT)/60000);
    const station = a.destName || "Overstap";

    // laat geen negatieve overstappen zien
    if (m < 0) continue;

    transfers.push({ station, minutes: m });
    if (minTransferMin === null || m < minTransferMin) minTransferMin = m;
  }
  return { transfers, minTransferMin };
}

function sortByStartTime(arr){
  return arr.sort((a,b)=> (+new Date(a.depart)) - (+new Date(b.depart)));
}

/* Convert NS trips payload (fallback for /reis) -> options */
function tripToOptionFromNS(trip){
  const legs = Array.isArray(trip?.legs) ? trip.legs : [];
  if (!legs.length) return null;

  const depart = legs[0]?.origin?.plannedDateTime || null;
  const arrive = legs[legs.length - 1]?.destination?.plannedDateTime || null;
  if (!depart || !arrive) return null;

  const depT = Date.parse(depart);
  const arrT = Date.parse(arrive);
  if (!isFinite(depT) || !isFinite(arrT)) return null;

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

/* ------------ state keys ------------ */
const LS = {
  van:"last_van",
  naar:"last_naar",
  mode:"planner_mode",            // "extreme" | "normal"
  searchType:"planner_searchType" // "depart" | "arrive"
};

/* ------------ elements ------------ */
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

/* mode toggle buttons */
const modeNormalBtn = document.getElementById("modeNormal");
const modeExtremeBtn = document.getElementById("modeExtreme");

/* ✅ keyboard weg als je ergens tikt (mobile) */
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
searchTypeEl.value = localStorage.getItem(LS.searchType) || "depart";
searchTypeEl.addEventListener("change", ()=> localStorage.setItem(LS.searchType, searchTypeEl.value));

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

/* ------------ MODE (standaard extreme) ------------ */
function setMode(mode){
  const m = (mode === "normal") ? "normal" : "extreme";
  localStorage.setItem(LS.mode, m);

  modeNormalBtn.classList.toggle("active", m === "normal");
  modeExtremeBtn.classList.toggle("active", m === "extreme");

  const hc = document.querySelector(".headerControls");
  if (hc) hc.textContent = (m === "extreme") ? "⚡ Extra korte overstappen" : "✅ Normale overstappen";
}
setMode(localStorage.getItem(LS.mode) || "extreme");

modeNormalBtn.addEventListener("click", ()=> setMode("normal"));
modeExtremeBtn.addEventListener("click", ()=> setMode("extreme"));

/* ------------ station autocomplete (min 2 letters) ------------ */
let vanList = [];
let naarList = [];

const stationCache = new Map(); // key: which:query -> array
let stationAbortVan = null;
let stationAbortNaar = null;

function setHint(which, text){
  if (which === "van") vanHint.textContent = text || "";
  if (which === "naar") naarHint.textContent = text || "";
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

  // cache doorzoeken
  for (const arr of stationCache.values()){
    const ex = (arr||[]).find(s=> normName(s.namen.lang) === wanted);
    if (ex) return ex.code;
  }

  // fallback: exacte check via API (alleen als min 2 letters)
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

/* duidelijke melding bij blur */
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
wisselBtnIcon.addEventListener("click", ()=>{
  const t = vanInput.value;
  vanInput.value = naarInput.value;
  naarInput.value = t;
  persistStations();
});

/* =========================
   OV helpers (arrival-only)
   ========================= */
const OV_CODE_BY_NAME = new Map([
  ["dordrecht", "ddr"],
  ["dordrecht zuid", "ddzd"],
  ["rotterdam blaak", "rtb"],
  ["rotterdam centraal", "rtd"],
  ["den haag hs", "gvh"],
  ["den haag centraal", "gvc"]
]);

function fmtHHMM(iso){
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
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

/* Render OV list with transfer time; hide negative + max 30 min */
function renderOvPanel(panelEl, title, ovData, trainArrIso){
  panelEl.innerHTML = "";

  const head = document.createElement("div");
  head.style.fontWeight = "900";
  head.textContent = title;
  panelEl.appendChild(head);

  const trainArrT = Date.parse(trainArrIso || "");
  const deps = Array.isArray(ovData?.departures) ? ovData.departures : [];

  let shown = 0;

  deps.slice(0, 30).forEach(d => {
    const depIso = d.expectedTime || d.plannedTime;
    const depT = Date.parse(depIso || "");
    if (!isFinite(depT) || !isFinite(trainArrT)) return;

    const transferMin = Math.round((depT - trainArrT) / 60000);

    if (transferMin < 0) return;
    if (transferMin > 30) return;

    shown++;

    const row = document.createElement("div");
    row.className = "ovItem";

    const left = document.createElement("div");
    left.className = "ovLeft";
    left.textContent = `${ovIcon(d.transportType)} ${d.line || ""}`.trim();

    const mid = document.createElement("div");
    mid.className = "ovMid";
    mid.textContent = d.destination || d.stopName || "";

    const right = document.createElement("div");
    right.className = "ovRight";
    right.textContent = fmtHHMM(depIso);

    if (Number(d.delayMin) > 0) {
      const dl = document.createElement("span");
      dl.className = "ovDelay";
      dl.textContent = `+${d.delayMin}`;
      right.appendChild(dl);
    }

    const badge = document.createElement("span");
    badge.className = `ovTransfer ${classifyOvTransfer(transferMin)}`;
    badge.textContent = `overstap ${transferMin} min`;

    row.appendChild(left);
    row.appendChild(mid);
    row.appendChild(right);
    row.appendChild(badge);

    panelEl.appendChild(row);
  });

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
    const data = await fetchJson(`/ov/by-station?station=${encodeURIComponent(stationCode)}`);
    renderOvPanel(panelEl, title, data, trainArrIso);
  } catch(e){
    panelEl.innerHTML = `<div class="small">${humanizeError(e)}</div>`;
  }
}

/* Render expandable trip card (lazy details) */
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

      const destNameNorm = normName(x.destName || "");
      const ovCode = OV_CODE_BY_NAME.get(destNameNorm) || null;
      const showOv = Boolean(ovCode && x.arr);

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

      if (showOv){
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ovBtn";
        btn.textContent = "OV";
        legLine.appendChild(btn);

        const panel = document.createElement("div");
        panel.className = "ovPanel";
        panel.style.display = "none";
        legEl.appendChild(panel);

        btn.addEventListener("click", async (e)=>{
          e.stopPropagation();

          if (openPanel && openPanel !== panel){
            openPanel.style.display = "none";
            openPanel.innerHTML = "";
          }

          const isOpen = panel.style.display !== "none";
          if (isOpen){
            panel.style.display = "none";
            panel.innerHTML = "";
            openPanel = null;
            return;
          }

          panel.style.display = "block";
          openPanel = panel;

          await loadOv(panel, ovCode, `Live OV bij ${x.destName}`, x.arr);
        });
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
   SEARCH (Normal / Extreme + vertrek/aankomst)
   ========================= */
const EXTREME_ENDPOINT = "/reis-extreme-b";
const NORMAL_ENDPOINT  = "/reis";

let inFlightSearch = null;

function getMode(){
  return localStorage.getItem(LS.mode) === "normal" ? "normal" : "extreme";
}

async function zoekReis(){
  humanErrorEl.textContent = "";
  resultaat.innerHTML = "";

  // client-side check: zelfde station
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
    const searchType = searchTypeEl.value; // depart|arrive
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

    // NB: searchForArrival wordt alleen gebruikt als backend het doorzet naar NS
    const url =
      `${endpoint}?van=${encodeURIComponent(vanCode)}&naar=${encodeURIComponent(naarCode)}&datetime=${encodeURIComponent(dt)}&searchForArrival=${encodeURIComponent(String(searchForArrival))}`;

    const data = await fetchJson(url, { signal });

    // extreme-b -> {options}; normal -> NS {trips} (fallback)
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
[vanInput, naarInput, dateInput, hourSelect, minuteSelect, searchTypeEl].forEach(el=>{
  el.addEventListener("keydown",(e)=>{
    if (e.key==="Enter"){ e.preventDefault(); zoekReis(); }
  });
});
zoekBtn.addEventListener("click", zoekReis);

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

    const up = document.createElement("button");
    up.className = "favMove";
    up.type = "button";
    up.textContent = "▲";
    up.title = "Omhoog";
    up.disabled = (i === 0);
    up.onclick = ()=>{
      const updated = moveItem(getFavs(), i, i-1);
      saveFavs(updated);
      laadFavorieten();
    };

    const down = document.createElement("button");
    down.className = "favMove";
    down.type = "button";
    down.textContent = "▼";
    down.title = "Omlaag";
    down.disabled = (i === favs.length - 1);
    down.onclick = ()=>{
      const updated = moveItem(getFavs(), i, i+1);
      saveFavs(updated);
      laadFavorieten();
    };

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

    right.appendChild(up);
    right.appendChild(down);
    right.appendChild(del);

    row.appendChild(left);
    row.appendChild(right);

    frag.appendChild(row);
  });

  favDiv.appendChild(frag);
}

favBtn.addEventListener("click", () => {
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

function showUpdateBanner(){ updateBanner.style.display = "block"; }
function hideUpdateBanner(){ updateBanner.style.display = "none"; }

reloadBtn.addEventListener("click", async ()=>{
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
