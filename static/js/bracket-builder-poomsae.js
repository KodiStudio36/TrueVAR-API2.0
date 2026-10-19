/* bracket-builder-poomsae.js — loaded by templates/dashboard/bracket_builder_poomsae.html,
 * after bracket-builder-common.js (see the contract at the top of that file). */
"use strict";

// ════════════════════════════════════════════════════════════════════
// POOMSAE bracket builder — cut-off / single elimination / round robin,
// courts balanced by estimated time, whole categories dragged between
// courts. No PSS vests, no plexi helmets, no rest-gap solver.
// Everything shared with kyorugi lives in /static/js/bracket-builder-common.js.
//
// Operator settings (all in `poomsaeConfig`, remembered per tournament in
// this browser):
//   • bracket system — one default + exceptions by type / age / belt
//   • running order  — entry types in the order courts run them
//   • courts by age  — which courts each age division may use
// ════════════════════════════════════════════════════════════════════

// Round time per poomsae type, in seconds. Written onto every match as
// `roundSeconds` (the court's round timer starts from it — see
// PoomsaeControlPlugin._duration_for_stage) and used to balance courts.
let poomsaeSecondsPerPerformance = 90;           // recognized poomsae
let poomsaeParaSecondsPerPerformance = 120;      // para poomsae runs longer
let poomsaeFreestyleSecondsPerPerformance = 100; // freestyle routine, max 100 s

function isParaCategory(cat) {
    return !!(cat && (cat.requiresPara || cat.paraClassCode));
}

// Freestyle categories — same test as the court plugin
// (is_freestyle_category: "freestyle" in the category code), plus the
// entry type in case the code doesn't spell it out.
function isFreestyleCategory(cat) {
    if (!cat) return false;
    const text = `${cat.code || ""} ${cat.categoryCode || ""} ${cat.entryTypeCode || ""} ${cat.entryTypeLabel || ""}`;
    return /freestyle/i.test(text);
}

// Round time for one category's matches: freestyle and para have their own.
function secondsPerMatchFor(cat) {
    if (isFreestyleCategory(cat)) return poomsaeFreestyleSecondsPerPerformance;
    return isParaCategory(cat) ? poomsaeParaSecondsPerPerformance : poomsaeSecondsPerPerformance;
}

// Choices offered per category. `system` is what gets pushed; cut-off's
// structure is a build option, not a separate system.
const POOMSAE_SYSTEMS = {
    cut_off: { label: "Cut-off (PR → SF → F by entrants)", system: "cut_off", structure: "auto" },
    cut_off_final: { label: "Cut-off — Final only", system: "cut_off", structure: "final_only" },
    single_elimination: { label: "Single elimination", system: "single_elimination" },
    round_robin: { label: "Round robin", system: "round_robin" },
};

const ANY = "*";

let poomsaeConfig = {
    defaultSystem: "cut_off",
    systemRules: [],     // [{ entryTypeCode, ageCode, beltClassCode, systemKey }] — each field a code or ANY
    typePriority: [],    // entryTypeCodes, first runs first
    ageCourts: {},       // ageCode -> [courtId]; missing/empty = any court
    ageOrder: "youngest_first",
};

// ── Shared-builder contract (see bracket-builder-common.js) ─────────
const HAS_REST_GAP_LOCK = false;
const MATCH_NUMBER_PAD = 3;

function newCourt(i) {
    return { id: String(i + 1), label: `Court ${i + 1}`, minGapBetweenSameAthlete: 3 };
}

async function init() {
    loadCourtsLocal();  // no fetch — courts never touch Firestore
    await Promise.all([
        loadPopulatedCategories(),
        BracketSheets.prepareAssets(), // logos + PDF font, so previews render synchronously
        loadPoomsaeDraw(),
    ]);
    loadPoomsaeConfig();
    document.getElementById("poomsaeSecondsInput").value = poomsaeSecondsPerPerformance;
    document.getElementById("poomsaeParaSecondsInput").value = poomsaeParaSecondsPerPerformance;
    document.getElementById("poomsaeFreestyleSecondsInput").value = poomsaeFreestyleSecondsPerPerformance;
    document.getElementById("ageOrderSelect").value = poomsaeConfig.ageOrder;
    renderCourtsList();
    renderSystemRules();
    renderTypePriority();
}

// Poomsae has no rest-gap solver and no equipment. Lock #3 (one court
// per category) and lock #2 (club spread) are checked by the shared
// checker; here only a non-blocking note when a category sits on a court
// its age division isn't set to use (possible after a manual drag).
function disciplineHardLockChecks(report) {
    generatedBrackets.forEach(b => {
        const allowed = allowedCourtIdsForAge(b.ageCode);
        if (b.courtId && allowed && !allowed.includes(b.courtId)) {
            report.notes.push(`${b.categoryLabel} is on ${(courtById(b.courtId) || {}).label || b.courtId}, outside the courts set for its age division`);
        }
    });
}

// Poomsae-only match fields:
//   roundSeconds  this match's round time by type (poomsae / para /
//                 freestyle) — the court plugin's round timer starts from it
//   poomsae       the keys drawn on the Poomsae Draw page for this match's
//                 category and round (see drawnPoomsaeFor); left out when
//                 the category wasn't drawn. Never for freestyle — the
//                 athletes perform their own routine.
function disciplineMatchFields(m) {
    const bracket = generatedBrackets.find(b => b.categoryCode === m.categoryCode);
    const fields = {};
    if (bracket && bracket.durationSeconds > 0) fields.roundSeconds = bracket.durationSeconds;
    const keys = bracket && bracket.isFreestyle ? null : drawnPoomsaeFor(m);
    if (keys) fields.poomsae = keys;
    return fields;
}

// ══════════════════════════════════════════════════════════════════
// POOMSAE DRAW → MATCHES
// The Poomsae Draw page (poomsae-draw.js) stores, per entry type × age ×
// rank, one poomsae for round 1, one for the semi-final and two for the
// final, in tournaments/{id}/meta/poomsaeDraw. Every match of a category
// gets the poomsae of the round it belongs to; the judge app and the
// operator panel show them.
// ══════════════════════════════════════════════════════════════════
let poomsaeDrawByRow = {};   // "<entryTypeCode>|<ageCode>|<beltClassCode>" -> {round1, semifinal, final: [a, b]}
let poomsaeDrawLoaded = false;

async function loadPoomsaeDraw() {
    try {
        const res = await fetch(`/api/tournaments/${TOURNAMENT_ID}/poomsae-draw`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        poomsaeDrawByRow = {};
        ((data.draw && data.draw.rows) || []).forEach(r => { poomsaeDrawByRow[r.key] = r; });
        poomsaeDrawLoaded = true;
    } catch (err) {
        console.warn("Poomsae draw not loaded — matches are pushed without poomsae", err);
        poomsaeDrawByRow = {};
        poomsaeDrawLoaded = false;
    }
}

const POOMSAE_NAMES = {
    taeguk_1: "Taeguk 1", taeguk_2: "Taeguk 2", taeguk_3: "Taeguk 3", taeguk_4: "Taeguk 4",
    taeguk_5: "Taeguk 5", taeguk_6: "Taeguk 6", taeguk_7: "Taeguk 7", taeguk_8: "Taeguk 8",
    koryo: "Koryo", keumgang: "Keumgang", taebaek: "Taebaek", pyongwon: "Pyongwon",
    sipjin: "Sipjin", jitae: "Jitae", cheonkwon: "Cheonkwon", hansu: "Hansu",
};

// "SF: Koryo · F: Taebaek + Jitae" for the court view block.
function drawSummaryOf(bracket) {
    if (!drawRowFor(bracket)) return "";
    return bracket.rounds.map((r, ri) => {
        const m = r.find(x => x.status !== "walkover");
        const keys = m && drawnPoomsaeFor(m);
        return keys ? `${roundGroupLabel(bracket, ri)}: ${keys.map(k => POOMSAE_NAMES[k] || k).join(" + ")}` : null;
    }).filter(Boolean).join(" · ");
}

function drawRowKeyOf(bracket) {
    return `${bracket.entryTypeCode}|${bracket.ageCode}|${bracket.beltClassCode || ""}`;
}

function drawRowFor(bracket) {
    return bracket ? poomsaeDrawByRow[drawRowKeyOf(bracket)] || null : null;
}

// Which drawn round a match belongs to:
//   cut-off          PR → round 1 · SF → semi-final · F → final
//   single elim.     last round → final · the one before → semi-final · earlier → round 1
//   round robin      every round → round 1 (no semi-final or final stage)
function drawRoundOf(m, bracket) {
    if (bracket.system === "cut_off") {
        if (m.roundPhase === "F") return "final";
        if (m.roundPhase === "SF") return "semifinal";
        return "round1";
    }
    if (bracket.system === "single_elimination") {
        const last = bracket.rounds.length;
        if (m.round === last) return "final";
        if (m.round === last - 1) return "semifinal";
        return "round1";
    }
    return "round1";
}

// Drawn poomsae keys for one match, or null when its category has no draw.
function drawnPoomsaeFor(m) {
    const bracket = generatedBrackets.find(b => b.categoryCode === m.categoryCode);
    const row = drawRowFor(bracket);
    if (!row) return null;
    const round = drawRoundOf(m, bracket);
    const keys = round === "final" ? (row.final || []) : [row[round]];
    const clean = keys.filter(Boolean);
    return clean.length ? clean : null;
}

// Written to tournaments/{id}/meta/equipment on push, so the settings
// behind a published schedule are on record.
function disciplineEquipmentPayload() {
    return {
        courts: courts.map(c => ({ id: c.id, label: c.label, minGapBetweenSameAthlete: c.minGapBetweenSameAthlete })),
        secondsPerMatch: poomsaeSecondsPerPerformance,
        paraSecondsPerMatch: poomsaeParaSecondsPerPerformance,
        freestyleSecondsPerMatch: poomsaeFreestyleSecondsPerPerformance,
        poomsaeScheduling: JSON.parse(JSON.stringify(poomsaeConfig)),
    };
}

// Court Order view: a whole category is the drag unit.
function renderCourtColumns() { renderPoomsaeCourtColumns(); }

// ══════════════════════════════════════════════════════════════════
// SETTINGS — load / save (per tournament, this browser only)
// ══════════════════════════════════════════════════════════════════
const POOMSAE_CONFIG_KEY = `truevar.poomsaeBuilder.${TOURNAMENT_ID}`;

function loadPoomsaeConfig() {
    try {
        const saved = JSON.parse(localStorage.getItem(POOMSAE_CONFIG_KEY) || "null");
        if (saved && typeof saved === "object") {
            if (POOMSAE_SYSTEMS[saved.defaultSystem]) poomsaeConfig.defaultSystem = saved.defaultSystem;
            if (Array.isArray(saved.systemRules)) {
                poomsaeConfig.systemRules = saved.systemRules
                    .filter(r => r && POOMSAE_SYSTEMS[r.systemKey])
                    .map(r => ({ entryTypeCode: r.entryTypeCode || ANY, ageCode: r.ageCode || ANY, beltClassCode: r.beltClassCode || ANY, systemKey: r.systemKey }));
            }
            if (Array.isArray(saved.typePriority)) poomsaeConfig.typePriority = saved.typePriority.slice();
            if (saved.ageCourts && typeof saved.ageCourts === "object") poomsaeConfig.ageCourts = saved.ageCourts;
            if (saved.ageOrder === "oldest_first" || saved.ageOrder === "youngest_first") poomsaeConfig.ageOrder = saved.ageOrder;
            if (saved.secondsPerMatch > 0) poomsaeSecondsPerPerformance = saved.secondsPerMatch;
            if (saved.paraSecondsPerMatch > 0) poomsaeParaSecondsPerPerformance = saved.paraSecondsPerMatch;
            if (saved.freestyleSecondsPerMatch > 0) poomsaeFreestyleSecondsPerPerformance = saved.freestyleSecondsPerMatch;
        }
    } catch (err) { /* storage unavailable or corrupt — start from defaults */ }
    poomsaeConfig.typePriority = reconcileTypePriority(poomsaeConfig.typePriority);
}

function savePoomsaeConfig() {
    try {
        localStorage.setItem(POOMSAE_CONFIG_KEY, JSON.stringify({
            ...poomsaeConfig,
            secondsPerMatch: poomsaeSecondsPerPerformance,
            paraSecondsPerMatch: poomsaeParaSecondsPerPerformance,
            freestyleSecondsPerMatch: poomsaeFreestyleSecondsPerPerformance,
        }));
    } catch (err) { /* private mode etc. — settings just won't persist */ }
}

function setSecondsPerMatch(value) {
    poomsaeSecondsPerPerformance = parseInt(value) || 90;
    savePoomsaeConfig();
}

function setParaSecondsPerMatch(value) {
    poomsaeParaSecondsPerPerformance = parseInt(value) || 120;
    savePoomsaeConfig();
}

function setFreestyleSecondsPerMatch(value) {
    poomsaeFreestyleSecondsPerPerformance = parseInt(value) || 100;
    savePoomsaeConfig();
}

function setAgeOrder(value) {
    poomsaeConfig.ageOrder = value;
    savePoomsaeConfig();
}

// ── Dimension option lists, from the categories that have entries ────
function uniqueBy(list, key) {
    const seen = new Map();
    list.forEach(item => { if (item[key] != null && item[key] !== "" && !seen.has(item[key])) seen.set(item[key], item); });
    return [...seen.values()];
}

function entryTypeOptions() {
    return uniqueBy(flatCategories, "entryTypeCode")
        .sort((a, b) => a.entryIndex - b.entryIndex)
        .map(c => ({ code: c.entryTypeCode, label: c.entryTypeLabel }));
}

function ageOptions() {
    return uniqueBy(flatCategories, "ageCode")
        .sort((a, b) => (a.ageMin ?? a.ageIndex) - (b.ageMin ?? b.ageIndex) || a.ageIndex - b.ageIndex)
        .map(c => ({ code: c.ageCode, label: c.ageLabel }));
}

function beltOptions() {
    return uniqueBy(flatCategories, "beltClassCode")
        .sort((a, b) => a.beltIndex - b.beltIndex)
        .map(c => ({ code: c.beltClassCode, label: c.beltClassLabel || c.beltClassCode }));
}

// ══════════════════════════════════════════════════════════════════
// BRACKET SYSTEM PER CATEGORY — default + exceptions
// ══════════════════════════════════════════════════════════════════
const RULE_FIELDS = [
    { key: "entryTypeCode", catKey: "entryTypeCode", anyLabel: "Any type", options: entryTypeOptions },
    { key: "ageCode", catKey: "ageCode", anyLabel: "Any age", options: ageOptions },
    { key: "beltClassCode", catKey: "beltClassCode", anyLabel: "Any belt", options: beltOptions },
];

// Belt column only when the schema actually splits by belt.
function activeRuleFields() {
    return RULE_FIELDS.filter(f => f.key !== "beltClassCode" || beltOptions().length > 0);
}

function ruleMatches(rule, cat) {
    return RULE_FIELDS.every(f => rule[f.key] === ANY || rule[f.key] === cat[f.catKey]);
}

function ruleSpecificity(rule) {
    return RULE_FIELDS.filter(f => rule[f.key] !== ANY).length;
}

// -> { key, ruleIndex, forced } — ruleIndex is null when the default
// applies. Most specific matching rule wins; ties go to the later rule.
// Freestyle is always a cut-off Final only (one round, no Preliminary or
// Semi-Final), whatever the default or the exceptions say.
function resolveSystem(cat) {
    if (isFreestyleCategory(cat)) return { key: "cut_off_final", ruleIndex: null, forced: true };
    let best = null;
    poomsaeConfig.systemRules.forEach((rule, i) => {
        if (!ruleMatches(rule, cat)) return;
        if (!best || ruleSpecificity(rule) >= ruleSpecificity(poomsaeConfig.systemRules[best])) best = i;
    });
    return best == null
        ? { key: poomsaeConfig.defaultSystem, ruleIndex: null }
        : { key: poomsaeConfig.systemRules[best].systemKey, ruleIndex: best };
}

function systemOptionsHtml(selected) {
    return Object.entries(POOMSAE_SYSTEMS)
        .map(([key, s]) => `<option value="${key}" ${key === selected ? "selected" : ""}>${escapeHtml(s.label)}</option>`)
        .join("");
}

function setDefaultSystem(value) {
    poomsaeConfig.defaultSystem = value;
    savePoomsaeConfig();
    renderSystemRules();
}

function addSystemRule() {
    const firstType = entryTypeOptions()[0];
    poomsaeConfig.systemRules.push({
        entryTypeCode: firstType ? firstType.code : ANY, ageCode: ANY, beltClassCode: ANY,
        systemKey: poomsaeConfig.defaultSystem === "single_elimination" ? "cut_off" : "single_elimination",
    });
    savePoomsaeConfig();
    renderSystemRules();
}

function updateSystemRule(index, field, value) {
    poomsaeConfig.systemRules[index][field] = value;
    savePoomsaeConfig();
    renderSystemRules();
}

function deleteSystemRule(index) {
    poomsaeConfig.systemRules.splice(index, 1);
    savePoomsaeConfig();
    renderSystemRules();
}

function renderSystemRules() {
    document.getElementById("defaultSystemSelect").innerHTML = systemOptionsHtml(poomsaeConfig.defaultSystem);

    const fields = activeRuleFields();
    const listEl = document.getElementById("systemRulesList");
    listEl.style.setProperty("--rule-cols", fields.length);

    listEl.innerHTML = poomsaeConfig.systemRules.map((rule, i) => {
        const selects = fields.map(f => {
            const opts = f.options();
            // Keep a saved code visible even if that option has no entries right now.
            const missing = rule[f.key] !== ANY && !opts.some(o => o.code === rule[f.key]);
            return `
                <select onchange="updateSystemRule(${i}, '${f.key}', this.value)">
                    <option value="${ANY}" ${rule[f.key] === ANY ? "selected" : ""}>${f.anyLabel}</option>
                    ${opts.map(o => `<option value="${escapeAttr(o.code)}" ${o.code === rule[f.key] ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
                    ${missing ? `<option value="${escapeAttr(rule[f.key])}" selected>${escapeHtml(rule[f.key])} (no entries)</option>` : ""}
                </select>`;
        }).join("");
        const applied = flatCategories.filter(c => resolveSystem(c).ruleIndex === i).length;
        const matched = flatCategories.filter(c => ruleMatches(rule, c)).length;
        const count = matched === 0
            ? `<span class="bb-rule-count bb-rule-count--none" title="No category with entries fits this exception">no categories</span>`
            : `<span class="bb-rule-count" title="${matched - applied} matching categor${matched - applied === 1 ? "y is" : "ies are"} taken by a more specific exception">${applied} categor${applied === 1 ? "y" : "ies"}</span>`;
        return `
            <div class="bb-rule-row">
                ${selects}
                <span class="bb-rule-arrow">→</span>
                <select onchange="updateSystemRule(${i}, 'systemKey', this.value)">${systemOptionsHtml(rule.systemKey)}</select>
                ${count}
                <button type="button" class="cm-bin-btn-inline" onclick="deleteSystemRule(${i})" title="Remove exception">✕</button>
            </div>`;
    }).join("") || `<p class="text-muted" style="font-size:0.8rem; margin:0;">No exceptions — every category uses the system above.</p>`;

    renderResolvedSystems();
}

function renderResolvedSystems() {
    const resolved = flatCategories.map(c => ({ cat: c, ...resolveSystem(c) }));
    const counts = {};
    resolved.forEach(r => { counts[r.key] = (counts[r.key] || 0) + 1; });
    document.getElementById("systemResolvedSummary").textContent =
        `Result per category — ${Object.entries(counts).map(([k, n]) => `${n} × ${POOMSAE_SYSTEMS[k].label}`).join(", ") || "no categories with entries"}`;

    document.getElementById("systemResolvedList").innerHTML = resolved
        .slice()
        .sort((a, b) => categorySortKey(a.cat, b.cat))
        .map(r => `
            <div class="bb-vest-row">
                <span>${escapeHtml(r.cat.groupLabel)} · ${escapeHtml(r.cat.label)}</span>
                <span>${escapeHtml(POOMSAE_SYSTEMS[r.key].label)}<span class="bb-rule-source">${r.forced ? "freestyle" : r.ruleIndex == null ? "default" : `exception ${r.ruleIndex + 1}`}</span></span>
            </div>`)
        .join("");

    // Seed placement only matters if something is single elimination.
    document.getElementById("placementFieldWrap").classList.toggle("hidden", !resolved.some(r => r.key === "single_elimination"));
}

// ══════════════════════════════════════════════════════════════════
// RUNNING ORDER BY TYPE
// ══════════════════════════════════════════════════════════════════
// Default guess from the type's code/label: individual → pairs → team →
// anything else → freestyle last. Ties keep schema order.
function defaultTypeRank(t) {
    const s = `${t.code} ${t.label}`.toLowerCase();
    if (s.includes("free")) return 90;
    if (s.includes("indiv") || s.includes("single") || s.includes("solo")) return 0;
    if (s.includes("pair") || s.includes("mix")) return 10;
    if (s.includes("team") || s.includes("group")) return 20;
    return 50;
}

// Saved order first (types that still exist), new types slotted in by
// default rank.
function reconcileTypePriority(saved) {
    const types = entryTypeOptions();
    const known = types.map(t => t.code);
    const kept = (saved || []).filter(code => known.includes(code));
    const fresh = types
        .map((t, i) => ({ ...t, i }))
        .filter(t => !kept.includes(t.code))
        .sort((a, b) => defaultTypeRank(a) - defaultTypeRank(b) || a.i - b.i);
    const result = kept.slice();
    fresh.forEach(t => {
        // Insert before the first kept type with a higher default rank.
        const at = result.findIndex(code => defaultTypeRank(types.find(x => x.code === code)) > defaultTypeRank(t));
        if (at === -1) result.push(t.code); else result.splice(at, 0, t.code);
    });
    return result;
}

function typeRank(entryTypeCode) {
    const i = poomsaeConfig.typePriority.indexOf(entryTypeCode);
    return i === -1 ? poomsaeConfig.typePriority.length : i;
}

function moveTypePriority(index, delta) {
    const list = poomsaeConfig.typePriority;
    const to = index + delta;
    if (to < 0 || to >= list.length) return;
    [list[index], list[to]] = [list[to], list[index]];
    savePoomsaeConfig();
    renderTypePriority();
}

function renderTypePriority() {
    const labels = Object.fromEntries(entryTypeOptions().map(t => [t.code, t.label]));
    const list = poomsaeConfig.typePriority;
    document.getElementById("typePriorityList").innerHTML = list.map((code, i) => `
        <div class="bb-priority-row">
            <span class="bb-priority-num">${i + 1}.</span>
            <span class="bb-priority-label">${escapeHtml(labels[code] || code)}</span>
            <button type="button" class="bb-icon-btn" onclick="moveTypePriority(${i}, -1)" ${i === 0 ? "disabled" : ""} title="Run earlier">↑</button>
            <button type="button" class="bb-icon-btn" onclick="moveTypePriority(${i}, 1)" ${i === list.length - 1 ? "disabled" : ""} title="Run later">↓</button>
        </div>
    `).join("") || `<p class="text-muted" style="font-size:0.8rem;">No categories with entries yet.</p>`;
}

// ══════════════════════════════════════════════════════════════════
// COURTS BY AGE DIVISION
// ══════════════════════════════════════════════════════════════════
// -> array of allowed court ids, or null when the division may use any court.
function allowedCourtIdsForAge(ageCode) {
    const ids = (poomsaeConfig.ageCourts[ageCode] || []).filter(id => courts.some(c => c.id === id));
    return ids.length ? ids : null;
}

function toggleAgeCourt(ageCode, courtId, on) {
    const set = new Set(poomsaeConfig.ageCourts[ageCode] || []);
    if (on) set.add(courtId); else set.delete(courtId);
    poomsaeConfig.ageCourts[ageCode] = [...set];
    savePoomsaeConfig();
    renderAgeCourts();
}

// Keeps age → court ticks attached when a court's ID is edited.
function renameCourtId(index, value) {
    const oldId = courts[index].id;
    const newId = value.trim();
    courts[index].id = newId;
    Object.values(poomsaeConfig.ageCourts).forEach(ids => {
        const at = ids.indexOf(oldId);
        if (at !== -1) ids[at] = newId;
    });
    savePoomsaeConfig();
    renderAgeCourts();
}

function renderAgeCourts() {
    const el = document.getElementById("ageCourtList");
    const ages = ageOptions();
    if (ages.length === 0) { el.innerHTML = `<p class="text-muted" style="font-size:0.8rem;">No categories with entries yet.</p>`; return; }
    if (courts.length === 0) { el.innerHTML = `<p class="text-muted" style="font-size:0.8rem;">Add courts first.</p>`; return; }

    el.innerHTML = ages.map(age => {
        const allowed = allowedCourtIdsForAge(age.code);
        const chips = courts.map(c => {
            const on = !!allowed && allowed.includes(c.id);
            return `
                <label class="bb-chip ${on ? "bb-chip--on" : ""}">
                    <input type="checkbox" ${on ? "checked" : ""} onchange="toggleAgeCourt(${escapeAttr(JSON.stringify(age.code))}, ${escapeAttr(JSON.stringify(c.id))}, this.checked)">
                    ${escapeHtml(c.label || c.id)}
                </label>`;
        }).join("");
        return `
            <div class="bb-sched-age-row">
                <span class="bb-sched-age-label">${escapeHtml(age.label)}</span>
                ${chips}
                ${allowed ? "" : `<span class="text-muted" style="font-size:0.75rem;">any court</span>`}
            </div>`;
    }).join("");
}

// Poomsae court rows: ID, label, min gap — no vest numbers, plexi
// checkbox or vest-gen lock. Re-renders the age → court grid too, since
// it lists the courts.
function renderCourtsList() {
    const el = document.getElementById("courtsList");
    if (courts.length === 0) {
        el.innerHTML = `<p class="text-muted" style="padding: 0.5rem 0;">No courts yet — add one below.</p>`;
    } else {
        el.innerHTML = courts.map((c, i) => `
            <div class="bb-court-row bb-court-row--poomsae">
                <input type="text" value="${escapeAttr(c.id)}" placeholder="Court ID" title="Must exactly match this court's TrueVAR-Core instance's own court_id"
                    style="font-weight: 600;" onchange="renameCourtId(${i}, this.value)">
                <input type="text" value="${escapeAttr(c.label)}" placeholder="Label" onchange="courts[${i}].label = this.value; renderAgeCourts()">
                <input type="number" min="0" value="${c.minGapBetweenSameAthlete}" title="Min matches between the same performer's back-to-back appearances"
                    onchange="courts[${i}].minGapBetweenSameAthlete = parseInt(this.value) || 0">
                <button type="button" class="cm-bin-btn-inline" onclick="deleteCourtRow(${i})" title="Remove court">✕</button>
            </div>
        `).join("");
    }
    renderAgeCourts();
}

// Running order within a court: type priority → age → belt → para class → gender.
function categorySortKey(a, b) {
    const ageA = a.ageMin ?? a.ageIndex, ageB = b.ageMin ?? b.ageIndex;
    const ageDir = poomsaeConfig.ageOrder === "oldest_first" ? -1 : 1;
    return typeRank(a.entryTypeCode) - typeRank(b.entryTypeCode)
        || ageDir * (ageA - ageB)
        || ageDir * ((a.ageIndex ?? 0) - (b.ageIndex ?? 0))
        || (a.beltIndex ?? 0) - (b.beltIndex ?? 0)
        || (a.paraIndex ?? 0) - (b.paraIndex ?? 0)
        || (a.genderIndex ?? 0) - (b.genderIndex ?? 0)
        || String(a.categoryCode || a.code).localeCompare(String(b.categoryCode || b.code));
}

// ══════════════════════════════════════════════════════════════════
// BRACKET SYSTEMS (poomsae-only ones stay local)
// ══════════════════════════════════════════════════════════════════
// ── POOMSAE: cut-off (solo, judged) ─────────────────────────────────
// Every entrant performs once, alone — `red` is genuinely null.
//
// STRUCTURE, when `structure` is "auto":
//   20+ entrants -> Preliminary Round (PR) -> ceil(N/2) -> Semi-Final (SF) -> 8 -> Final (F)
//   9-19 entrants -> Semi-Final (SF) -> 8 -> Final (F)
//   <=8 entrants  -> Final (F)
// "final_only": always exactly one Final round.
//
// Later rounds are pre-created PLACEHOLDERS (blue.pendingAdvancement)
// with fixed matchId / number / court / position. An external process
// writes the advancing entryId onto the existing doc later.
function generateCutOff(categoryCode, entries, structure) {
    const n = entries.length;
    let stageCodes;
    if (structure === "final_only") {
        stageCodes = ["F"];
    } else if (n >= 20) {
        stageCodes = ["PR", "SF", "F"];
    } else if (n > 8) {
        stageCodes = ["SF", "F"];
    } else {
        stageCodes = ["F"];
    }

    function slotsForNextStage(fromCount, fromStageCode) {
        if (fromStageCode === "PR") return Math.ceil(fromCount / 2);
        return Math.min(8, fromCount);
    }

    const rounds = [];
    let prevCount = n;
    let matchCounter = 1;

    stageCodes.forEach((stageCode, stageIdx) => {
        const isFirstStage = stageIdx === 0;
        const slotCount = isFirstStage ? n : slotsForNextStage(prevCount, stageCodes[stageIdx - 1]);

        const roundMatches = [];
        for (let i = 0; i < slotCount; i++) {
            if (isFirstStage) {
                roundMatches.push({
                    matchId: `${categoryCode}_${stageCode}_perf${i + 1}`,
                    categoryCode, round: stageIdx + 1, matchNumber: matchCounter++,
                    roundPhase: stageCode,
                    blue: cornerFromEntry(entries[i]), red: null,
                    status: "ready", winnerEntryId: null,
                    courtId: null, queuePosition: null,
                    format: "solo",
                });
            } else {
                roundMatches.push({
                    matchId: `${categoryCode}_${stageCode}_perf${i + 1}`,
                    categoryCode, round: stageIdx + 1, matchNumber: matchCounter++,
                    roundPhase: stageCode,
                    blue: { entryId: null, pendingAdvancement: true, fromRoundIndex: stageIdx - 1 }, red: null,
                    status: "pending", winnerEntryId: null,
                    courtId: null, queuePosition: null,
                    format: "solo",
                });
            }
        }
        rounds.push(roundMatches);
        prevCount = slotCount;
    });

    return { rounds, bracketSize: n, entrySlotIndex: {}, conflictCount: 0 };
}

// ── POOMSAE: round robin (head-to-head) ─────────────────────────────
// Circle method: fix entry 0, rotate the rest through N-1 rounds. An
// odd entry count gets a null "bye" seat — whoever draws it sits out.
function generateRoundRobin(categoryCode, entries) {
    const list = entries.slice();
    if (list.length % 2 === 1) list.push(null);
    const n = list.length;
    const roundsCount = n - 1;
    const rounds = [];
    let matchCounter = 1;
    let arr = list.slice();

    for (let r = 0; r < roundsCount; r++) {
        const roundMatches = [];
        for (let i = 0; i < n / 2; i++) {
            const a = arr[i], b = arr[n - 1 - i];
            if (a && b) {
                roundMatches.push({
                    matchId: `${categoryCode}_rr${r + 1}_m${i + 1}`,
                    categoryCode, round: r + 1, matchNumber: matchCounter++,
                    roundPhase: `RR${r + 1}`,
                    blue: cornerFromEntry(a), red: cornerFromEntry(b),
                    status: "ready", winnerEntryId: null,
                    courtId: null, queuePosition: null,
                    format: "duel",
                });
            }
        }
        if (roundMatches.length > 0) rounds.push(roundMatches);
        arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
    }

    return { rounds, bracketSize: n, entrySlotIndex: {}, conflictCount: 0 };
}

// Matches that actually take floor time. Single-elimination byes
// ("walkover") are never pushed, so they get no court slot or number.
function realMatchesOf(bracket) {
    return bracket.rounds.flat().filter(m => m.status !== "walkover");
}

// ── POOMSAE: court scheduler ────────────────────────────────────────
// A whole CATEGORY is the unit assigned to a court (lock #3 holds by
// construction). Each category may only go to the courts its age
// division is set to (any court if none). Most-restricted categories are
// placed first, longest first, each onto the allowed court with the least
// running time so far. Within a court: type priority → age → belt →
// gender. Every slot counts, including cut-off placeholders.
// Each bracket's durationSeconds already reflects its own per-match
// estimate (para categories run longer — see secondsPerMatchFor).
function generatePoomsaeCourtOrdering(brackets) {
    if (courts.length === 0) return { placedCount: 0, unassigned: [], courtSeconds: {} };

    const courtSeconds = {};
    const courtCategories = {};
    courts.forEach(c => { courtSeconds[c.id] = 0; courtCategories[c.id] = []; });

    const sized = brackets.map(b => {
        const perMatch = b.durationSeconds || poomsaeSecondsPerPerformance;
        const matchCount = realMatchesOf(b).length;
        const allowed = allowedCourtIdsForAge(b.ageCode) || courts.map(c => c.id);
        return { bracket: b, totalSeconds: matchCount * perMatch, allowed };
    });
    sized.sort((a, b) => a.allowed.length - b.allowed.length || b.totalSeconds - a.totalSeconds);

    sized.forEach(({ bracket: b, totalSeconds, allowed }) => {
        let best = null;
        allowed.forEach(id => { if (best === null || courtSeconds[id] < courtSeconds[best]) best = id; });
        b.courtId = best;
        courtSeconds[best] += totalSeconds;
        courtCategories[best].push(b);
    });

    let placedCount = 0;
    courts.forEach(c => {
        const ordered = courtCategories[c.id].slice().sort(categorySortKey);
        let pos = 0;
        ordered.forEach(b => {
            realMatchesOf(b).forEach(m => {
                m.courtId = c.id;
                m.queuePosition = pos++;
                placedCount++;
            });
        });
    });

    return { placedCount, unassigned: [], courtSeconds };
}

// POOMSAE numbering: one continuous 001, 002... sequence across the
// whole event, interleaved round-robin by position across courts.
function computeMatchNumbersPoomsae() {
    const byCourt = courts.map(c => generatedMatches
        .filter(m => m.courtId === c.id)
        .sort((a, b) => a.queuePosition - b.queuePosition));
    let globalNum = 1;
    let idx = 0;
    let anyLeft = true;
    while (anyLeft) {
        anyLeft = false;
        byCourt.forEach(list => {
            if (idx < list.length) {
                list[idx].displayNumber = globalNum++;
                anyLeft = true;
            }
        });
        idx++;
    }
}

async function generateEverything() {
    if (!ensureReadyToGenerate()) return;
    await loadPoomsaeDraw(); // fresh — the draw may have been redone in another tab

    const placementFn = PLACEMENT_STRATEGIES[document.getElementById("placementSelect").value];

    const { skippedSingleEntryCount, totalConflicts } = await buildAllBrackets({
        categories: flatCategories.slice().sort(categorySortKey),
        // Pushed system per category; the cut-off structure is resolved again in build().
        systemKey: cat => POOMSAE_SYSTEMS[resolveSystem(cat).key].system,
        allowSingleEntry: (cat, system) => system === "cut_off", // a solo performance needs no opponent
        build: (cat, seeded, system) => {
            if (system === "single_elimination") return generateSingleElimination(cat.code, seeded, placementFn);
            if (system === "round_robin") return generateRoundRobin(cat.code, seeded);
            return generateCutOff(cat.code, seeded, POOMSAE_SYSTEMS[resolveSystem(cat).key].structure);
        },
        extraBracketFields: cat => ({
            // Round time by type (poomsae / para / freestyle) — pushed on
            // every match as roundSeconds, and the court-balancing estimate.
            durationSeconds: secondsPerMatchFor(cat),
            isPara: isParaCategory(cat),
            isFreestyle: isFreestyleCategory(cat),
            // Used by the scheduler (court per age, running order) and the court view.
            entryTypeCode: cat.entryTypeCode, ageCode: cat.ageCode, beltClassCode: cat.beltClassCode,
            entryIndex: cat.entryIndex, ageIndex: cat.ageIndex, beltIndex: cat.beltIndex, paraIndex: cat.paraIndex, genderIndex: cat.genderIndex,
            cutOffStructure: POOMSAE_SYSTEMS[resolveSystem(cat).key].structure || null,
        }),
    });

    const orderingResult = generatePoomsaeCourtOrdering(generatedBrackets);
    computeMatchNumbersPoomsae();
    rebuildMatchById();
    const lockReport = refreshHardLockReport();

    const systemsUsed = {};
    generatedBrackets.forEach(b => {
        const label = b.system === "cut_off" && b.cutOffStructure === "final_only" ? "cut-off (final only)" : b.system.replace(/_/g, " ").replace("cut off", "cut-off");
        systemsUsed[label] = (systemsUsed[label] || 0) + 1;
    });
    const undrawn = generatedBrackets.filter(b => !drawRowFor(b));
    const drawNote = !poomsaeDrawLoaded
        ? `<span style="color:#b45309;">poomsae draw couldn't be loaded — matches will have no poomsae</span>`
        : undrawn.length === 0
            ? `drawn poomsae attached to every category`
            : `<span style="color:#b45309;" title="${escapeHtml(undrawn.map(b => b.categoryLabel).join("\n"))}">${undrawn.length} categor${undrawn.length === 1 ? "y has" : "ies have"} no drawn poomsae (excluded or not drawn yet)</span>`;
    const minutesPerCourt = courts.map(c => `${escapeHtml(c.label)}: ~${Math.round((orderingResult.courtSeconds[c.id] || 0) / 60)} min`).join(", ");

    showGenerationResults([
        `${generatedBrackets.length} bracket(s) generated (${Object.entries(systemsUsed).map(([k, n]) => `${n} ${k}`).join(", ")})`,
        `${orderingResult.placedCount} match(es) scheduled onto courts`,
        `running time — ${minutesPerCourt}`,
        drawNote,
        skippedSingleEntryCount > 0 && `<span style="color:#b45309;">${skippedSingleEntryCount} categor${skippedSingleEntryCount === 1 ? "y" : "ies"} skipped (only 1 entrant, nothing to bracket)</span>`,
        totalConflicts > 0 && `<span style="color:#b45309;">${totalConflicts} unavoidable same-club first-round pair(s)</span>`,
    ], lockReport);
}

// ══════════════════════════════════════════════════════════════════
// POOMSAE COURT VIEW — a whole category is the drag unit.
// ══════════════════════════════════════════════════════════════════
let draggedCategoryCode = null;

const CATEGORY_BLOCK_PX_PER_MATCH = 16;

const CATEGORY_BLOCK_MIN_H = 72;

function firstQueuePosition(bracket) {
    let min = Infinity;
    bracket.rounds.forEach(r => r.forEach(m => { if (m.queuePosition != null) min = Math.min(min, m.queuePosition); }));
    return min === Infinity ? 0 : min;
}

function categoriesForCourt(courtId) {
    return generatedBrackets.filter(b => b.courtId === courtId).sort((a, b) => firstQueuePosition(a) - firstQueuePosition(b));
}

function renumberCourtCategories(courtId, orderedBrackets) {
    let pos = 0;
    orderedBrackets.forEach(b => {
        b.courtId = courtId;
        realMatchesOf(b).forEach(m => {
            m.courtId = courtId;
            m.queuePosition = pos++;
        });
    });
}

function renderPoomsaeCourtColumns() {
    const el = document.getElementById("courtColumns");
    el.innerHTML = courts.map(court => {
        const cats = categoriesForCourt(court.id);
        return `
            <div class="bb-court-column" data-court-id="${court.id}"
                ondragover="onPoomsaeColumnDragOver(event, this)" ondragleave="onPoomsaeColumnDragLeave(event, this)" ondrop="onPoomsaeColumnDrop(event, this)">
                <div class="bb-court-column-header">${escapeHtml(court.label)}</div>
                <div class="bb-court-column-body">
                    ${cats.map(b => renderCategoryBlock(b)).join("") || `<p class="text-muted" style="font-size:0.82rem; padding: 0.5rem 0;">No categories assigned.</p>`}
                </div>
            </div>
        `;
    }).join("");
    document.getElementById("unassignedWarning").classList.add("hidden");
}

function renderCategoryBlock(bracket) {
    const real = realMatchesOf(bracket);
    const matchCount = real.length;
    const height = Math.max(CATEGORY_BLOCK_MIN_H, matchCount * CATEGORY_BLOCK_PX_PER_MATCH);
    const stageSummary = bracket.rounds.map((r, ri) => `${roundGroupLabel(bracket, ri)}: ${r.filter(m => m.status !== "walkover").length}`).join(" · ");
    const perMatch = bracket.durationSeconds || poomsaeSecondsPerPerformance;
    const estMinutes = Math.round((matchCount * perMatch) / 60);
    const firstNum = real.length ? formatMatchNumber(real[0]) : "—";
    const lastNum = real.length ? formatMatchNumber(real[real.length - 1]) : "—";
    const drawSummary = drawSummaryOf(bracket);

    return `
        <div class="bb-category-block" style="height:${height}px;" draggable="true" data-category-code="${bracket.categoryCode}"
            ondragstart="onCategoryBlockDragStart(event, this)" ondragend="onCategoryBlockDragEnd(event, this)">
            <div class="bb-category-block-title">${escapeHtml(bracket.categoryLabel)}</div>
            <div class="text-muted" style="font-size:0.72rem;">${bracket.entries.length} entries · ${matchCount} matches (${firstNum}–${lastNum}) · ~${estMinutes} min${bracket.isPara || bracket.isFreestyle ? ` · ${perMatch}s/match` : ""}</div>
            <div class="text-muted" style="font-size:0.7rem;">${escapeHtml(stageSummary)}</div>
            ${drawSummary ? `<div style="font-size:0.7rem;color:var(--accent,#4f46e5);font-weight:600;">${escapeHtml(drawSummary)}</div>` : ""}
        </div>
    `;
}

function onCategoryBlockDragStart(event, el) {
    draggedCategoryCode = el.dataset.categoryCode;
    el.classList.add("bb-category-block--dragging");
    event.dataTransfer.effectAllowed = "move";
}

function onCategoryBlockDragEnd(event, el) {
    el.classList.remove("bb-category-block--dragging");
    removeBlockDropIndicator();
    document.querySelectorAll(".bb-court-column--drop-target").forEach(c => c.classList.remove("bb-court-column--drop-target"));
}

let blockDropIndicatorEl = null;

function ensureBlockDropIndicator() {
    if (!blockDropIndicatorEl) {
        blockDropIndicatorEl = document.createElement("div");
        blockDropIndicatorEl.className = "bb-drop-indicator";
    }
    return blockDropIndicatorEl;
}

function removeBlockDropIndicator() {
    if (blockDropIndicatorEl && blockDropIndicatorEl.parentNode) blockDropIndicatorEl.parentNode.removeChild(blockDropIndicatorEl);
}

function computeBlockDropIndex(bodyEl, clientY) {
    const blocks = [...bodyEl.querySelectorAll(".bb-category-block")];
    let dropIndex = blocks.length;
    for (let i = 0; i < blocks.length; i++) {
        const rect = blocks[i].getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) { dropIndex = i; break; }
    }
    return { dropIndex, blocks };
}

function onPoomsaeColumnDragOver(event, columnEl) {
    event.preventDefault();
    if (!draggedCategoryCode) return;
    const bodyEl = columnEl.querySelector(".bb-court-column-body");
    const { dropIndex, blocks } = computeBlockDropIndex(bodyEl, event.clientY);
    const indicator = ensureBlockDropIndicator();
    if (dropIndex >= blocks.length) bodyEl.appendChild(indicator);
    else bodyEl.insertBefore(indicator, blocks[dropIndex]);
    document.querySelectorAll(".bb-court-column--drop-target").forEach(c => { if (c !== columnEl) c.classList.remove("bb-court-column--drop-target"); });
    columnEl.classList.add("bb-court-column--drop-target");
}

function onPoomsaeColumnDragLeave(event, columnEl) {
    if (!columnEl.contains(event.relatedTarget)) columnEl.classList.remove("bb-court-column--drop-target");
}

function onPoomsaeColumnDrop(event, columnEl) {
    event.preventDefault();
    columnEl.classList.remove("bb-court-column--drop-target");
    removeBlockDropIndicator();
    if (!draggedCategoryCode) return;

    const targetCourtId = columnEl.dataset.courtId;
    const bracket = generatedBrackets.find(b => b.categoryCode === draggedCategoryCode);
    if (!bracket) { draggedCategoryCode = null; return; }
    const sourceCourtId = bracket.courtId;

    const bodyEl = columnEl.querySelector(".bb-court-column-body");
    const { dropIndex } = computeBlockDropIndex(bodyEl, event.clientY);

    const targetList = categoriesForCourt(targetCourtId).filter(b => b.categoryCode !== draggedCategoryCode);
    targetList.splice(dropIndex, 0, bracket);
    renumberCourtCategories(targetCourtId, targetList);

    if (sourceCourtId && sourceCourtId !== targetCourtId) {
        renumberCourtCategories(sourceCourtId, categoriesForCourt(sourceCourtId));
    }

    draggedCategoryCode = null;
    computeMatchNumbersPoomsae();
    refreshHardLockReport();
    renderCourtColumns();
    renderBracketsPreview();
}

init();