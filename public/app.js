
// app.js — Toepoel's Planner v1.09.1 (Safari OV time fix)

function normalizeTZ(s){
  return String(s || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
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

function fmtTime(iso){
  const d = safeDate(iso);
  if (!d) return "—";
  return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}

function fmtHHMM(iso){
  const d = safeDate(iso);
  if (!d) return "—";
  return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}

/*
IN renderOvPanel() vervang:
Date.parse(trainArrIso)
Date.parse(depIso)

DOOR:
safeParseTime(trainArrIso)
safeParseTime(depIso)
*/

console.log("OV Safari time fix loaded (v1.09.1)");
