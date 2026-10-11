/* ════════════════════════════════════════════════════════════════════
 * poomsae-draw.js — the Poomsae Draw page (templates/dashboard/poomsae_draw.html).
 *
 *   Pools        named poomsae lists ("Category B", "Category A Juniors" …)
 *   Assignments  which pool each age × rank group uses
 *   Draw         per category row (entry type × age × rank): one poomsae
 *                for round 1 (20+), one for the semi-final (9–19) and two
 *                for the final (1–8) — all four different. Every category
 *                of the schema is drawn (the draw happens before
 *                registration closes), except excluded ones: freestyle and
 *                para by default, plus any the operator switches off.
 *
 * Settings and the draw are saved in tournaments/{id}/meta/poomsaeDraw via
 * /api/tournaments/{id}/poomsae-draw. The random draw itself happens on
 * the server (see generate_poomsae_draw in api_router.py).
 *
 * Page constants (TOURNAMENT_*) come from the template.
 * ════════════════════════════════════════════════════════════════════ */
"use strict";

const POOMSAE = [
    { key: "taeguk_1", name: "Taeguk 1. Jang", short: "1" },
    { key: "taeguk_2", name: "Taeguk 2. Jang", short: "2" },
    { key: "taeguk_3", name: "Taeguk 3. Jang", short: "3" },
    { key: "taeguk_4", name: "Taeguk 4. Jang", short: "4" },
    { key: "taeguk_5", name: "Taeguk 5. Jang", short: "5" },
    { key: "taeguk_6", name: "Taeguk 6. Jang", short: "6" },
    { key: "taeguk_7", name: "Taeguk 7. Jang", short: "7" },
    { key: "taeguk_8", name: "Taeguk 8. Jang", short: "8" },
    { key: "koryo", name: "Koryo", short: "Koryo" },
    { key: "keumgang", name: "Keumgang", short: "Keumgang" },
    { key: "taebaek", name: "Taebaek", short: "Taebaek" },
    { key: "pyongwon", name: "Pyongwon", short: "Pyongwon" },
    { key: "sipjin", name: "Sipjin", short: "Sipjin" },
    { key: "jitae", name: "Jitae", short: "Jitae" },
    { key: "cheonkwon", name: "Cheonkwon", short: "Cheonkwon" },
    { key: "hansu", name: "Hansu", short: "Hansu" },
];
const POOMSAE_BY_KEY = Object.fromEntries(POOMSAE.map(p => [p.key, p]));
const MIN_POOL_SIZE = 4; // round 1 + semi-final + 2 in the final

const T = n => `taeguk_${n}`;

// Default pools (the organiser's standard set-up):
//   All athletes B     Taeguk 4–8                                  (every Class B)
//   Youth athletes A   Taeguk 4–8, Koryo, Keumgang                 (Class A pupils → juniors)
//   Under 40 A         Taeguk 4–8, Koryo … Sipjin                  (Class A seniors up to 40)
//   Over 40 A          Taeguk 8, Koryo … Hansu                     (Class A seniors over 40)
// Classes C and D are excluded from the draw by default.
const DEFAULT_POOLS = [
    { id: "all_b", name: "All athletes B", poomsae: [T(4), T(5), T(6), T(7), T(8)] },
    { id: "youth_a", name: "Youth athletes A", poomsae: [T(4), T(5), T(6), T(7), T(8), "koryo", "keumgang"] },
    { id: "under40_a", name: "Under 40 A", poomsae: [T(4), T(5), T(6), T(7), T(8), "koryo", "keumgang", "taebaek", "pyongwon", "sipjin"] },
    { id: "over40_a", name: "Over 40 A", poomsae: [T(8), "koryo", "keumgang", "taebaek", "pyongwon", "sipjin", "jitae", "cheonkwon", "hansu"] },
];

let pools = [];            // [{id, name, poomsae: [key]}]
let assignments = {};      // "<ageCode>|<beltClassCode>" -> poolId
let draw = null;           // {rows: [{key, label, poolId, round1, semifinal, final: [a, b]}], generatedAt}
let categories = [];       // flat categories from the schema (category-schema.js)
let excludedOverrides = {}; // rowKey -> true (skip) / false (draw) — only where it differs from the default
let excludedGroups = {};    // groupKey -> true (skip) / false (draw) — only where it differs from defaultGroupExcluded
let allGroups = new Map(); // every age × rank group in the schema
let groups = [];           // groups used by at least one drawn row: [{key, ageCode, beltClassCode, label, guessPoolId, guessed}]
let drawRows = [];         // [{key, groupKey, label, typeReason}]
let dirty = false;

// ── Helpers ─────────────────────────────────────────────────────────
function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function showFlash(text, isError) {
    const el = document.getElementById("flash");
    el.textContent = text;
    el.className = `flash-banner ${isError ? "flash-banner--error" : ""}`;
    clearTimeout(showFlash._t);
    showFlash._t = setTimeout(() => el.classList.add("hidden"), isError ? 7000 : 3000);
}

async function api(path, method = "GET", body) {
    const opts = { method };
    if (body !== undefined) {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api/tournaments/${TOURNAMENT_ID}/poomsae-draw${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const d = data.detail;
        throw new Error(typeof d === "string" ? d : Array.isArray(d) ? d.map(x => x.msg).join("; ") : `Request failed (${res.status})`);
    }
    return data;
}

function short(key) { return (POOMSAE_BY_KEY[key] || {}).short || key || ""; }
function poolById(id) { return pools.find(p => p.id === id) || null; }
function sortedKeys(keys) { return POOMSAE.map(p => p.key).filter(k => keys.includes(k)); }
function markDirty() { dirty = true; document.getElementById("saveBtn").classList.add("btn-primary"); document.getElementById("saveBtn").classList.remove("btn-ghost"); }
function markClean() { dirty = false; document.getElementById("saveBtn").classList.remove("btn-primary"); document.getElementById("saveBtn").classList.add("btn-ghost"); }

// ── Default pool for an age × rank group ───────────────────────────
// Reads the schema's own codes/labels.
//   Class B (gup/keup)                       → All athletes B
//   Class A, pupils / cadets / juniors       → Youth athletes A
//   Class A, seniors "under N" (N ≤ 40),
//            "over N" (N < 40)               → Under 40 A
//   Class A, seniors "under N" (N > 40),
//            "over N" (N ≥ 40), veterans     → Over 40 A
// Anything these rules don't cover gets the closest pool and is marked
// "check" on the page.
function beltClassOf(group) {
    const belt = `${group.beltClassCode || ""} ${group.beltLabel || ""}`.toLowerCase();
    if (/(^|[^a-z])d([^a-z]|$)/.test(belt)) return "D";
    if (/(^|[^a-z])c([^a-z]|$)/.test(belt)) return "C";
    if (/(^|[^a-z])b([^a-z]|$)|gup|keup|kup/.test(belt)) return "B";
    if (/(^|[^a-z])a([^a-z]|$)|dan|poom/.test(belt)) return "A";
    return null;
}

function defaultPoolFor(group) {
    const cls = beltClassOf(group);
    const age = `${group.ageCode || ""} ${group.ageLabel || ""}`.toLowerCase();

    if (cls === "B" || cls === "C" || cls === "D") return { poolId: "all_b", guessed: cls !== "B" };

    const confident = cls === "A";
    if (/pupil|žiak|ziak|child|kid|mini|younger|cadet|kadet|junior|junio/.test(age)) {
        return { poolId: "youth_a", guessed: !confident };
    }
    if (/senior|senio|adult|veteran|master|over|under|nad|do/.test(age)) {
        const num = (age.match(/(\d{2})/) || [])[1];
        const n = num ? Number(num) : null;
        const over = /over|nad|\bo_?\d|_o\d|\+/.test(age);
        if (/veteran|master/.test(age)) return { poolId: "over40_a", guessed: !confident };
        if (n == null) return { poolId: "under40_a", guessed: true };
        const older = over ? n >= 40 : n > 40;
        return { poolId: older ? "over40_a" : "under40_a", guessed: !confident };
    }
    return { poolId: cls === "A" ? "under40_a" : "all_b", guessed: true };
}

// Classes C and D aren't drawn by default (tick "Exclude" off to draw them).
function defaultGroupExcluded(group) {
    const cls = beltClassOf(group);
    return cls === "C" || cls === "D";
}

// ── Load ────────────────────────────────────────────────────────────
async function init() {
    try {
        const [schemaRes, saved] = await Promise.all([
            fetch(`/api/tournaments/${TOURNAMENT_ID}/categories`).then(r => r.json()),
            api(""),
        ]);
        categories = TrueVARCategories.flatten(TrueVARCategories.dimensionsFor(schemaRes, TOURNAMENT_SPORT, TOURNAMENT_DISCIPLINE));
        excludedOverrides = saved.excludedRows || {};
        excludedGroups = saved.excludedGroups || {};
        pools = (saved.pools && saved.pools.length) ? saved.pools : JSON.parse(JSON.stringify(DEFAULT_POOLS));
        assignments = saved.assignments || {};
        draw = saved.draw || null;
        if (!saved.pools || !saved.pools.length) markDirty();
    } catch (err) {
        console.error(err);
        showFlash(`Couldn't load: ${err.message}`, true);
        pools = JSON.parse(JSON.stringify(DEFAULT_POOLS));
    }
    buildGroupsAndRows();
    refreshGroups();
    renderAll();
}

// Freestyle and para categories aren't drawn by default (they don't
// perform recognized poomsae from these pools); any row can be switched.
function defaultExclusion(c) {
    if (c.requiresPara || c.paraClassCode) return "Para";
    if (/free/i.test(`${c.entryTypeCode} ${c.entryTypeLabel}`)) return "Freestyle";
    return null;
}

function buildGroupsAndRows() {
    allGroups = new Map();
    const rowMap = new Map();
    categories.forEach(c => {
        const belt = c.beltClassCode || "";
        const gKey = `${c.ageCode}|${belt}`;
        if (!allGroups.has(gKey)) {
            const g = {
                key: gKey, ageCode: c.ageCode, beltClassCode: belt, ageLabel: c.ageLabel, beltLabel: c.beltClassLabel,
                label: [c.ageLabel, c.beltClassLabel].filter(Boolean).join(" · "),
                ageIndex: c.ageIndex, beltIndex: c.beltIndex,
            };
            const guess = defaultPoolFor(g);
            g.guessPoolId = guess.poolId;
            g.guessed = guess.guessed;
            allGroups.set(gKey, g);
        }

        const rKey = `${c.entryTypeCode}|${c.ageCode}|${belt}`;
        if (!rowMap.has(rKey)) {
            const reason = defaultExclusion(c);
            rowMap.set(rKey, {
                key: rKey, groupKey: gKey, entryTypeLabel: c.entryTypeLabel,
                label: [c.entryTypeLabel, c.ageLabel, c.beltClassLabel].filter(Boolean).join(" "),
                entryIndex: c.entryIndex, ageIndex: c.ageIndex, beltIndex: c.beltIndex,
                typeReason: reason,
            });
        }
    });
    drawRows = [...rowMap.values()].sort((a, b) => a.entryIndex - b.entryIndex || a.ageIndex - b.ageIndex || a.beltIndex - b.beltIndex);
}

// Default for a row: skipped when it's freestyle/para, or when its whole
// age × rank group is ticked "Exclude". A row switch overrides either.
function isGroupExcluded(groupKey) {
    if (groupKey in excludedGroups) return !!excludedGroups[groupKey];
    const g = allGroups.get(groupKey);
    return !!g && defaultGroupExcluded(g);
}

function rowDefaultExcluded(row) {
    return !!row.typeReason || isGroupExcluded(row.groupKey);
}

function rowExcludeReason(row) {
    if (row.typeReason) return row.typeReason;
    if (isGroupExcluded(row.groupKey)) return "Group excluded";
    return null;
}

function isExcluded(row) {
    return row.key in excludedOverrides ? !!excludedOverrides[row.key] : rowDefaultExcluded(row);
}

function includedRows() {
    return drawRows.filter(r => !isExcluded(r));
}

// A group gets an assignment row when some drawn row uses it, or when it
// has rows that are only skipped because of the group's own "Exclude"
// tick (so it stays listed and can be unticked). An age group that exists
// just for para/freestyle doesn't clutter the list.
// A group without a saved pool gets the default guess.
function refreshGroups() {
    const used = new Map();
    drawRows.forEach(r => {
        const listed = !isExcluded(r) || (!r.typeReason && isGroupExcluded(r.groupKey));
        if (!listed) return;
        const g = allGroups.get(r.groupKey);
        if (!used.has(g.key)) used.set(g.key, { ...g, entryTypes: new Set() });
        used.get(g.key).entryTypes.add(r.entryTypeLabel);
    });
    groups = [...used.values()].sort((a, b) => a.ageIndex - b.ageIndex || a.beltIndex - b.beltIndex);
    groups.forEach(g => {
        if (!poolById(assignments[g.key])) {
            assignments[g.key] = g.guessPoolId;
            markDirty();
        }
    });
}

function toggleExcluded(key) {
    const row = drawRows.find(r => r.key === key);
    if (!row) return;
    const next = !isExcluded(row);
    if (next === rowDefaultExcluded(row)) delete excludedOverrides[key];
    else excludedOverrides[key] = next;
    markDirty();
    refreshGroups();
    renderAll();
}

// Ticking "Exclude" on an age × rank group skips all its categories
// (individuals, pairs, teams) by default. Per-row switches in that group
// are reset so the group setting takes effect for all of them.
function toggleGroupExcluded(groupKey) {
    const next = !isGroupExcluded(groupKey);
    const g = allGroups.get(groupKey);
    if (g && next === defaultGroupExcluded(g)) delete excludedGroups[groupKey];
    else excludedGroups[groupKey] = next;
    drawRows.filter(r => r.groupKey === groupKey).forEach(r => { delete excludedOverrides[r.key]; });
    markDirty();
    refreshGroups();
    renderAll();
}

// ── Render ──────────────────────────────────────────────────────────
function renderAll() {
    renderPools();
    renderAssignments();
    renderDraw();
}

function renderPools() {
    document.getElementById("poolList").innerHTML = pools.map((p, i) => {
        const shortPool = p.poomsae.length < MIN_POOL_SIZE;
        const usedBy = groups.filter(g => !isGroupExcluded(g.key) && assignments[g.key] === p.id).length;
        return `
            <div class="pd-pool ${shortPool ? "pd-pool--short" : ""}">
                <div class="pd-pool-name">
                    <input type="text" value="${escapeHtml(p.name)}" onchange="renamePool(${i}, this.value)">
                    <div class="pd-pool-meta text-muted">${p.poomsae.length} poomsae · used by ${usedBy} group${usedBy === 1 ? "" : "s"}${shortPool ? ` · <strong style="color:#b91c1c;">needs at least ${MIN_POOL_SIZE}</strong>` : ""}</div>
                </div>
                <div class="pd-chips">
                    ${POOMSAE.map(ps => `<span class="pd-chip ${p.poomsae.includes(ps.key) ? "pd-chip--on" : ""}" title="${escapeHtml(ps.name)}" onclick="togglePoomsae(${i}, '${ps.key}')">${escapeHtml(ps.key.startsWith("taeguk") ? `Taeguk ${ps.short}` : ps.name)}</span>`).join("")}
                </div>
                <button type="button" class="pd-icon-btn" title="${usedBy ? "In use — reassign its groups first" : "Delete pool"}" ${usedBy ? "disabled style=\"opacity:.3;cursor:not-allowed\"" : ""} onclick="deletePool(${i})">✕</button>
            </div>`;
    }).join("");
}

function poolOptions(selected) {
    return pools.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === selected ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
}

function renderAssignments() {
    document.getElementById("bulkPoolSelect").innerHTML = poolOptions(pools[0] && pools[0].id);
    const el = document.getElementById("assignmentList");
    if (groups.length === 0) {
        el.innerHTML = `<p class="text-muted">No categories in this tournament's schema yet.</p>`;
        return;
    }
    el.innerHTML = groups.map(g => {
        const off = isGroupExcluded(g.key);
        const guessedAndUntouched = !off && g.guessed && assignments[g.key] === g.guessPoolId;
        return `
            <div class="pd-assign-row ${off ? "pd-assign-row--off" : ""}" title="${escapeHtml([...g.entryTypes].join(", "))}">
                <span class="pd-assign-label"><strong>${escapeHtml(g.label || g.ageCode)}</strong>${guessedAndUntouched ? `<span class="pd-guess-tag">check</span>` : ""}</span>
                <label class="pd-exclude" title="Don't draw any category of this group">
                    <input type="checkbox" ${off ? "checked" : ""} onchange="toggleGroupExcluded('${escapeHtml(g.key)}')"> Exclude
                </label>
                <select ${off ? "disabled" : ""} onchange="assignPool('${escapeHtml(g.key)}', this.value)">${poolOptions(assignments[g.key])}</select>
            </div>`;
    }).join("");
}

// A drawn row is "stale" when its group now uses a different pool, or a
// drawn poomsae was removed from that pool — highlighted so it's redrawn.
function isStale(row, drawn) {
    if (!drawn) return false;
    const pool = poolById(assignments[row.groupKey]);
    if (!pool || drawn.poolId !== pool.id) return true;
    return [drawn.round1, drawn.semifinal, ...(drawn.final || [])].some(k => !pool.poomsae.includes(k));
}

function renderDraw() {
    const byKey = Object.fromEntries(((draw && draw.rows) || []).map(r => [r.key, r]));
    const body = document.getElementById("drawBody");
    body.innerHTML = drawRows.map(r => {
        const excluded = isExcluded(r);
        const toggle = `<button type="button" class="pd-skip ${excluded ? "pd-skip--off" : ""}" title="${excluded ? "Not drawn — click to include in the draw" : "Click to exclude from the draw"}" onclick="toggleExcluded('${escapeHtml(r.key)}')">${excluded ? "Skip" : "Draw"}</button>`;
        if (excluded) {
            return `
            <tr class="pd-row-excluded">
                <td>${escapeHtml(r.label)}</td>
                <td colspan="3" class="pd-empty">Not drawn${rowExcludeReason(r) && !(r.key in excludedOverrides) ? ` — ${escapeHtml(rowExcludeReason(r).toLowerCase())}` : ""}</td>
                <td class="pd-actions">${toggle}</td>
            </tr>`;
        }
        const d = byKey[r.key];
        const stale = isStale(r, d);
        const cell = v => v ? escapeHtml(v) : `<span class="pd-empty">—</span>`;
        return `
            <tr class="${stale ? "pd-row-stale" : ""}" title="${stale ? "Pool changed since this was drawn — redraw this row" : ""}">
                <td>${escapeHtml(r.label)}</td>
                <td>${cell(d && short(d.round1))}</td>
                <td>${cell(d && short(d.semifinal))}</td>
                <td>${cell(d && d.final && d.final.map(short).join("/"))}</td>
                <td class="pd-actions">${toggle}<button type="button" class="pd-redraw" title="Draw this category again" onclick="redrawRow('${escapeHtml(r.key)}')">↻</button></td>
            </tr>`;
    }).join("") || `<tr><td colspan="5" class="pd-empty">No categories in this tournament's schema yet.</td></tr>`;

    const rows = includedRows();
    const excludedCount = drawRows.length - rows.length;
    const staleCount = rows.filter(r => isStale(r, byKey[r.key])).length;
    document.getElementById("drawMeta").innerHTML = draw && draw.generatedAt
        ? `Drawn ${escapeHtml(new Date(draw.generatedAt).toLocaleString())} · ${rows.filter(r => byKey[r.key]).length} of ${rows.length} categories drawn${excludedCount ? ` · ${excludedCount} excluded` : ""}${staleCount ? ` · <strong style="color:#b45309;">${staleCount} row${staleCount === 1 ? "" : "s"} out of date</strong>` : ""}`
        : `Not drawn yet · ${rows.length} categories to draw${excludedCount ? ` · ${excludedCount} excluded` : ""}.`;
    document.getElementById("pdfBtn").disabled = !(draw && draw.rows && draw.rows.length);
    document.getElementById("applyBtn").disabled = !(draw && draw.rows && draw.rows.length);
}

// ── Pool editing ────────────────────────────────────────────────────
function togglePoomsae(i, key) {
    const p = pools[i];
    p.poomsae = p.poomsae.includes(key) ? p.poomsae.filter(k => k !== key) : sortedKeys([...p.poomsae, key]);
    markDirty();
    renderPools();
    renderDraw();
}

function renamePool(i, name) {
    pools[i].name = name.trim() || pools[i].name;
    markDirty();
    renderAll();
}

function addPool() {
    let n = pools.length + 1;
    while (pools.some(p => p.id === `pool_${n}`)) n++;
    pools.push({ id: `pool_${n}`, name: `Pool ${n}`, poomsae: [] });
    markDirty();
    renderAll();
}

function deletePool(i) {
    const p = pools[i];
    if (groups.some(g => assignments[g.key] === p.id)) return;
    if (!confirm(`Delete pool "${p.name}"?`)) return;
    pools.splice(i, 1);
    markDirty();
    renderAll();
}

function resetPoolsToDefault() {
    if (!confirm("Replace all pools, assignments and group exclusions with the defaults? (The draw itself is kept.)")) return;
    pools = JSON.parse(JSON.stringify(DEFAULT_POOLS));
    assignments = {};
    excludedGroups = {};
    markDirty();
    refreshGroups(); // fills every group with its default pool
    allGroups.forEach(g => { if (!poolById(assignments[g.key])) assignments[g.key] = g.guessPoolId; });
    renderAll();
}

function assignPool(groupKey, poolId) {
    assignments[groupKey] = poolId;
    markDirty();
    renderPools();
    renderAssignments();
    renderDraw();
}

function assignAll() {
    const poolId = document.getElementById("bulkPoolSelect").value;
    const pool = poolById(poolId);
    if (!pool || !confirm(`Use "${pool.name}" for every age & rank group?`)) return;
    groups.forEach(g => { assignments[g.key] = poolId; });
    markDirty();
    renderAll();
}

// ── Save / draw ─────────────────────────────────────────────────────
async function saveConfig(silent) {
    const btn = document.getElementById("saveBtn");
    btn.disabled = true;
    try {
        const res = await api("/config", "PUT", { pools, assignments, excludedRows: excludedOverrides, excludedGroups });
        pools = res.pools;
        assignments = { ...assignments, ...res.assignments };
        markClean();
        if (!silent) showFlash("Settings saved.");
        renderAll();
        return true;
    } catch (err) {
        showFlash(`Save failed: ${err.message}`, true);
        return false;
    } finally {
        btn.disabled = false;
    }
}

function rowRequest(r) {
    const pool = poolById(assignments[r.groupKey]);
    return { key: r.key, label: r.label, poolId: pool ? pool.id : null, poomsae: pool ? pool.poomsae : [] };
}

async function generateDraw() {
    const rows = includedRows(); // every category of the schema, entries or not — minus excluded ones
    if (rows.length === 0) { showFlash("No categories to draw.", true); return; }
    const tooSmall = rows.filter(r => rowRequest(r).poomsae.length < MIN_POOL_SIZE);
    if (tooSmall.length) {
        showFlash(`These use a pool with fewer than ${MIN_POOL_SIZE} poomsae: ${tooSmall.slice(0, 5).map(r => r.label).join(", ")}${tooSmall.length > 5 ? "…" : ""}`, true);
        return;
    }
    if (draw && draw.rows && draw.rows.length && !confirm(`Draw all ${rows.length} categories again? The current draw is replaced.`)) return;

    const btn = document.getElementById("drawBtn");
    btn.disabled = true;
    btn.textContent = "Drawing…";
    try {
        if (dirty && !(await saveConfig(true))) return;
        const res = await api("/generate", "POST", { rows: rows.map(rowRequest), replaceAll: true });
        draw = res.draw;
        renderDraw();
        showFlash(`Drawn ${draw.rows.length} categories.`);
    } catch (err) {
        showFlash(`Draw failed: ${err.message}`, true);
    } finally {
        btn.disabled = false;
        btn.textContent = "Draw poomsae";
    }
}

async function redrawRow(key) {
    const r = drawRows.find(x => x.key === key);
    if (!r || isExcluded(r)) return;
    const req = rowRequest(r);
    if (req.poomsae.length < MIN_POOL_SIZE) { showFlash(`"${r.label}" uses a pool with fewer than ${MIN_POOL_SIZE} poomsae.`, true); return; }
    const existing = draw && (draw.rows || []).find(x => x.key === key);
    if (existing && !confirm(`Draw "${r.label}" again?`)) return;
    try {
        if (dirty && !(await saveConfig(true))) return;
        const res = await api("/generate", "POST", { rows: [req], replaceAll: false });
        draw = res.draw;
        renderDraw();
        showFlash(`"${r.label}" drawn again.`);
    } catch (err) {
        showFlash(`Draw failed: ${err.message}`, true);
    }
}

// ── Apply to already-pushed matches ─────────────────────────────────
// The bracket builder attaches the draw when brackets are pushed. For a
// draw made or redone AFTER that, this writes it onto the existing match
// docs (the operator panel / judge app pick it up on the next reload).
async function applyDrawToMatches() {
    if (dirty && !confirm("Settings have unsaved changes — they don't affect the drawn poomsae. Apply the saved draw anyway?")) return;
    if (!confirm("Write the current draw onto every match already pushed for this tournament?")) return;
    const btn = document.getElementById("applyBtn");
    btn.disabled = true;
    try {
        const q = new URLSearchParams({ sport: TOURNAMENT_SPORT, discipline: TOURNAMENT_DISCIPLINE });
        const res = await api(`/apply-to-matches?${q}`, "POST");
        showFlash(res.updated || res.cleared
            ? `Poomsae written to ${res.updated} match${res.updated === 1 ? "" : "es"}${res.cleared ? `, removed from ${res.cleared} undrawn` : ""}.`
            : "No pushed matches found for this tournament.");
    } catch (err) {
        showFlash(`Apply failed: ${err.message}`, true);
    } finally {
        btn.disabled = false;
    }
}

// ── PDF ─────────────────────────────────────────────────────────────
// Same look as the other generated sheets: logos + tournament header,
// Unicode font from bracket-sheets.js, a plain black grid like the
// published draw tables.
async function downloadDrawPdf() {
    if (!window.jspdf || !window.jspdf.jsPDF) { showFlash("PDF library failed to load — check your connection and retry.", true); return; }
    const byKey = Object.fromEntries(((draw && draw.rows) || []).map(r => [r.key, r]));
    const rows = includedRows().filter(r => byKey[r.key]);
    if (rows.length === 0) { showFlash("Nothing drawn to print.", true); return; }

    const btn = document.getElementById("pdfBtn");
    btn.disabled = true;
    try {
        await BracketSheets.prepareAssets();
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
        const font = await BracketSheets.applyPdfFont(doc);
        const t = s => BracketSheets.pdfText(doc, s);
        const logos = BracketSheets.getLogoAssets();
        const pageW = doc.internal.pageSize.getWidth();
        const margin = 14;

        const drawHeader = () => {
            if (logos.left) doc.addImage(logos.left.dataUrl, "PNG", margin, 8, 18 * logos.left.width / Math.max(logos.left.width, logos.left.height), 18 * logos.left.height / Math.max(logos.left.width, logos.left.height), logos.left.alias, "FAST");
            if (logos.right) {
                const w = 20 * logos.right.width / Math.max(logos.right.width, logos.right.height);
                const h = 20 * logos.right.height / Math.max(logos.right.width, logos.right.height);
                doc.addImage(logos.right.dataUrl, "PNG", pageW - margin - w, 8, w, h, logos.right.alias, "FAST");
            }
            doc.setFont(font, "bold");
            doc.setFontSize(14);
            doc.setTextColor(17, 17, 17);
            doc.text(t(TOURNAMENT_TITLE), pageW / 2, 14, { align: "center" });
            doc.setFont(font, "normal");
            doc.setFontSize(10);
            doc.text(t([TOURNAMENT_LOCATION, TOURNAMENT_DATE].filter(Boolean).join(", ")), pageW / 2, 20, { align: "center" });
            doc.setFont(font, "bold");
            doc.setFontSize(12);
            doc.text(t("Poomsae draw"), pageW / 2, 28, { align: "center" });
        };

        doc.autoTable({
            startY: 33,
            margin: { left: margin, right: margin, top: 33 },
            head: [[t("Category"), t("1. round (20+ competitors)"), t("Semifinals (9–19 competitors)"), t("Finals (1–8 competitors)")]],
            body: rows.map(r => {
                const d = byKey[r.key];
                return [t(r.label), t(short(d.round1)), t(short(d.semifinal)), t((d.final || []).map(short).join("/"))];
            }),
            theme: "grid",
            styles: { font, fontSize: 9, cellPadding: 1.4, lineColor: [17, 17, 17], lineWidth: 0.25, textColor: [17, 17, 17], valign: "middle" },
            headStyles: { font, fontStyle: "bold", fillColor: [255, 255, 255], textColor: [17, 17, 17], halign: "center", fontSize: 8.5 },
            columnStyles: {
                0: { cellWidth: 70, fontStyle: "bold" },
                1: { halign: "center" },
                2: { halign: "center" },
                3: { halign: "center" },
            },
            didDrawPage: drawHeader,
        });

        const pages = doc.getNumberOfPages();
        for (let i = 1; i <= pages; i++) {
            doc.setPage(i);
            doc.setFont(font, "normal");
            doc.setFontSize(7.5);
            doc.setTextColor(100, 116, 139);
            const stamp = draw.generatedAt ? `Drawn ${new Date(draw.generatedAt).toLocaleString()}` : "";
            doc.text(t(stamp), margin, doc.internal.pageSize.getHeight() - 8);
            doc.text(`${i} / ${pages}`, pageW - margin, doc.internal.pageSize.getHeight() - 8, { align: "right" });
        }

        const safe = (TOURNAMENT_TITLE || "tournament").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "tournament";
        doc.save(`${safe}_poomsae_draw.pdf`);
    } catch (err) {
        console.error(err);
        showFlash(`PDF failed: ${err.message}`, true);
    } finally {
        btn.disabled = false;
    }
}

window.addEventListener("beforeunload", e => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
});

init();