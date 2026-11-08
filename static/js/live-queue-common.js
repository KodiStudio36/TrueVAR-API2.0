/* ════════════════════════════════════════════════════════════════════
 * live-queue-common.js — everything the kyorugi and poomsae live queues
 * share: the ONE realtime match listener, court columns, drag-and-drop
 * re-ordering, the match detail editor, corner replacement, winner
 * propagation, bulk edit, insert match, compute results, bracket PDFs,
 * "Print New Results", club standings and the print helpers.
 *
 * Loaded by templates/dashboard/live_queue_base.html AFTER the page
 * constants (TOURNAMENT_ID, SPORT, DISCIPLINE, TOURNAMENT_TITLE) and
 * category-schema.js / bracket-core.js / bracket-sheets.js; BEFORE
 * live-queue-bracket-sync.js and the discipline's own files. The last
 * discipline file calls startLiveQueue(discipline).
 *
 * Corner replacements and deleted matches are written to the bracket doc
 * too — see live-queue-bracket-sync.js (syncBracketForReplacement,
 * eliminationTreeFor, 🔧 Sync Brackets, 🗑 Delete Match).
 *
 * CONTRACT — the discipline object passed to startLiveQueue():
 *   init()                    async, optional — extra loads after the
 *                             listener starts (kyorugi: equipment meta)
 *   conflicts(byCourt)        -> Map<matchId, reason> (empty Map for none)
 *   formatOf(match)           -> the FORMAT module that handles this match
 *                                (kyorugi: one; poomsae: cut-off or duel)
 *   bulkFields                [{key, label, type: "text"|"number", placeholder}]
 *   insert                    {requiresRed, roundPhases, fieldsHtml(),
 *                              read() -> extra fields, format(hasRed),
 *                              actions: [{id, label, after(newMatch)}]}
 *   sheetKinds                [{kind, title, fileSuffix,
 *                               collect(bracketDocs) -> [{code, label, …}],
 *                               print(items), download(items, filename)}] —
 *                             draw sheets for systems BracketSheets has no
 *                             layout for (poomsae: round robin). Single
 *                             elimination and cut-off sheets are built in —
 *                             the same sheets the bracket builder prints.
 *   resultKinds               [{kind, title, fileSuffix,
 *                               collect() -> items, print(items),
 *                               download(items, filename)}] — extra
 *                             "Print New Results" kinds. Single-elimination
 *                             and cut-off sheets are built in.
 *
 * FORMAT module (one per way a match is run):
 *   key                       "kyorugi" | "poomsae_cutoff" | "poomsae_duel"
 *   solo                      true → one performer, no red corner
 *   roundPhases               phases offered in the detail editor
 *   statusOptions             [[value, label]] for the detail editor
 *   winnerStatuses            statuses that need a winner picked
 *   rowExtraHtml(m)           badges / score line under the names
 *   rowButtons(m)             [{kind, title, label}] small row buttons
 *   onRowButton(kind, m, btn)
 *   detailFieldsHtml(m)       extra inputs in the detail grid
 *   detailUpdates(m)          -> extra fields read back from those inputs
 *   detailReadonlyHtml(m)     extra read-only info
 *   detailActionsHtml(m)      extra footer buttons
 *   openResult(matchId)       the view for a decided match
 * Missing members fall back to the defaults in FORMAT_DEFAULTS below.
 * ════════════════════════════════════════════════════════════════════ */
"use strict";

let fsDb = null;
let unsubscribe = null;
let LQ = null; // the discipline object — see startLiveQueue()

// Single source of truth for every match in this tournament, kept in
// sync incrementally via docChanges() in subscribeAll().
let matchesById = new Map();

let dragState = null; // { matchId, fromCourtId }

// categoryCode -> categoryLabel, fetched ONCE from the tournament's own
// /brackets collection (match docs only carry categoryCode).
let categoryLabelByCode = {};

// Statuses of a match/performance that was never run — count as finished
// for scheduling (never "next up") and for the cut-off ranking.
const NOT_PERFORMED = new Set(["withdrawn", "dns", "dsq", "disqualified", "cancelled", "walkover"]);

const FORMAT_DEFAULTS = {
    key: "generic",
    solo: false,
    roundPhases: ["R32", "R16", "QF", "SF", "F"],
    statusOptions: [["pending", "Pending"], ["ready", "Ready"], ["done", "Completed"], ["walkover", "Walkover"]],
    winnerStatuses: ["done", "walkover"],
    rowExtraHtml: () => "",
    rowButtons: () => [],
    onRowButton: () => { },
    detailFieldsHtml: () => "",
    detailUpdates: () => ({}),
    detailReadonlyHtml: () => "",
    detailActionsHtml: () => "",
    openResult: null, // null → the generic detail editor also handles decided matches
};

function formatOf(m) {
    return { ...FORMAT_DEFAULTS, ...((LQ && LQ.formatOf && LQ.formatOf(m)) || {}) };
}

// ── Bootstrapping ───────────────────────────────────────────────────────
async function startLiveQueue(discipline) {
    LQ = {
        init: null,
        conflicts: () => new Map(),
        bulkFields: [],
        insert: { requiresRed: true, roundPhases: FORMAT_DEFAULTS.roundPhases, fieldsHtml: () => "", read: () => ({}), format: () => null, actions: [] },
        sheetKinds: [],
        resultKinds: [],
        ...discipline,
    };
    await initFirebase();
    subscribeAll();
    loadCategoryLabels(); // fire-and-forget — rows show raw codes until labels arrive
    loadAgeCodes();       // fire-and-forget — bulk edit's "entire age division"
    if (LQ.init) LQ.init();
}

async function loadCategoryLabels() {
    try {
        const snap = await fsDb.collection("tournaments").doc(TOURNAMENT_ID).collection("brackets").get();
        snap.forEach((doc) => {
            const data = doc.data();
            if (data.categoryCode) categoryLabelByCode[data.categoryCode] = data.categoryLabel || data.categoryCode;
        });
        renderCourts();
    } catch (err) {
        console.error("Failed to load category labels", err);
    }
}

function resolveCategoryLabel(code) {
    return categoryLabelByCode[code] || code || "";
}

// Match docs carry only categoryCode, never ageCode. The age division is
// one "_"-separated part of the code. The list comes from the tournament's
// own category schema (category-schema.js), with the usual codes as a
// fallback; longest first so "seniors_under_30" wins over "seniors".
let knownAgeCodes = [
    "pupils", "pupils_1", "pupils_2", "younger_cadets", "cadets", "juniors", "seniors", "veterans",
    "seniors_under_30", "seniors_over_30", "seniors_under_40", "seniors_under_50", "seniors_over_50",
    "children", "under_17", "over_17",
].sort((a, b) => b.length - a.length);

async function loadAgeCodes() {
    try {
        if (!window.TrueVARCategories) return;
        const res = await fetch(`/api/tournaments/${TOURNAMENT_ID}/categories`);
        const dims = TrueVARCategories.dimensionsFor(await res.json(), String(SPORT).toLowerCase(), String(DISCIPLINE).toLowerCase());
        const codes = [...new Set(TrueVARCategories.flatten(dims).map(c => c.ageCode).filter(Boolean))];
        if (codes.length) knownAgeCodes = [...new Set([...codes, ...knownAgeCodes])].sort((a, b) => b.length - a.length);
    } catch (err) {
        console.warn("Category schema not loaded — using the default age codes", err);
    }
}

function ageCodeForCategoryCode(categoryCode) {
    if (!categoryCode) return null;
    const wrapped = `_${categoryCode}_`;
    return knownAgeCodes.find(code => wrapped.includes(`_${code}_`)) || null;
}

// ═══════════════════════════════════════════════════════════════════
// BULK EDIT — apply the discipline's bulk fields (kyorugi: round/break
// time, PSS size, hit level; poomsae: round seconds) to every match in
// ONE category or a whole AGE DIVISION, in one batched write.
// ═══════════════════════════════════════════════════════════════════

function matchesForBulkScope(scopeVal) {
    if (!scopeVal) return [];
    const sepIdx = scopeVal.indexOf(":");
    const kind = scopeVal.slice(0, sepIdx);
    const value = scopeVal.slice(sepIdx + 1);
    const result = [];
    matchesById.forEach((m) => {
        if (kind === "cat" && m.categoryCode === value) result.push(m);
        if (kind === "age" && ageCodeForCategoryCode(m.categoryCode) === value) result.push(m);
    });
    return result;
}

function openBulkEditModal() {
    const categoriesPresent = new Map(); // categoryCode -> label
    matchesById.forEach((m) => {
        if (m.categoryCode) categoriesPresent.set(m.categoryCode, resolveCategoryLabel(m.categoryCode));
    });

    const ageDivisionsPresent = new Map(); // ageCode -> count of distinct categories
    categoriesPresent.forEach((label, code) => {
        const ageCode = ageCodeForCategoryCode(code);
        if (!ageCode) return;
        ageDivisionsPresent.set(ageCode, (ageDivisionsPresent.get(ageCode) || 0) + 1);
    });

    if (categoriesPresent.size === 0) {
        openModal(`
            <div class="lq-modal-header">
                <h3>Bulk Edit Category Settings</h3>
                <button class="lq-modal-close" onclick="closeModal()">&times;</button>
            </div>
            <div class="lq-modal-body">
                <p class="lq-field-hint">No matches loaded yet — push brackets first.</p>
                <div class="lq-modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>
            </div>
        `);
        return;
    }

    const categoryOptionsHtml = [...categoriesPresent.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([code, label]) => `<option value="cat:${escapeAttr(code)}">${escapeHtml(label)}</option>`)
        .join("");

    const ageOptionsHtml = [...ageDivisionsPresent.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([ageCode, count]) => `<option value="age:${escapeAttr(ageCode)}">All ${escapeHtml(ageCode.replace(/_/g, " "))} (${count} categor${count === 1 ? "y" : "ies"})</option>`)
        .join("");

    const fieldsHtml = LQ.bulkFields.map(f => `
        <label>${escapeHtml(f.label)} <input type="${f.type === "number" ? "number" : "text"}" id="bulk-${f.key}" placeholder="${escapeAttr(f.placeholder || "unchanged")}"></label>
    `).join("");

    openModal(`
        <div class="lq-modal-header">
            <h3>Bulk Edit Category Settings</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">
                Applies to every match currently in the chosen scope. Leave a field blank to leave it
                unchanged. Useful for fixing a mistake across many matches at once, mid-tournament.
            </p>
            <div class="lq-form-field">
                <label style="display:block; font-size:.72rem; font-weight:700; color:var(--lq-muted); text-transform:uppercase; margin-bottom:.3rem;">Apply to</label>
                <select id="bulk-scope">
                    <optgroup label="Single category">${categoryOptionsHtml}</optgroup>
                    ${ageOptionsHtml ? `<optgroup label="Entire age division">${ageOptionsHtml}</optgroup>` : ""}
                </select>
            </div>
            <div class="lq-detail-grid" style="margin-top:1rem;">${fieldsHtml}</div>
            <p id="bulk-preview" class="lq-field-hint" style="margin-top:.75rem;"></p>
            <div id="bulk-error" class="lq-alert-error hidden"></div>
            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="bulk-apply-btn" onclick="applyBulkEdit()">Apply</button>
                <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
            </div>
        </div>
    `);

    const updatePreview = () => {
        const count = matchesForBulkScope(document.getElementById("bulk-scope").value).length;
        document.getElementById("bulk-preview").textContent = `This will update ${count} match(es).`;
    };
    document.getElementById("bulk-scope").onchange = updatePreview;
    updatePreview();
}

async function applyBulkEdit() {
    const errEl = document.getElementById("bulk-error");
    errEl.classList.add("hidden");

    const scopeVal = document.getElementById("bulk-scope").value;
    const updates = {};
    LQ.bulkFields.forEach(f => {
        const raw = document.getElementById(`bulk-${f.key}`).value.trim();
        if (raw === "") return;
        if (f.type === "number") {
            const n = Number(raw);
            if (!Number.isNaN(n)) updates[f.key] = n;
        } else {
            updates[f.key] = raw;
        }
    });

    if (Object.keys(updates).length === 0) {
        errEl.textContent = "Enter at least one field to change.";
        errEl.classList.remove("hidden");
        return;
    }

    const matches = matchesForBulkScope(scopeVal);
    if (matches.length === 0) {
        errEl.textContent = "No matches in that scope.";
        errEl.classList.remove("hidden");
        return;
    }

    if (!confirm(`Apply these changes to ${matches.length} match(es)? This can't be undone from here.`)) return;

    const btn = document.getElementById("bulk-apply-btn");
    btn.disabled = true;
    btn.textContent = "Applying…";

    try {
        // Firestore batched writes cap at 500 — chunk defensively.
        const CHUNK = 400;
        for (let i = 0; i < matches.length; i += CHUNK) {
            const batch = fsDb.batch();
            matches.slice(i, i + CHUNK).forEach((m) => batch.set(matchDocRef(m.id), updates, { merge: true }));
            await batch.commit();
        }
        closeModal();
        // The realtime listener re-renders from the docChanges.
    } catch (err) {
        console.error("Bulk edit failed", err);
        errEl.textContent = "Bulk edit failed: " + err.message;
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Apply";
    }
}

// ═══════════════════════════════════════════════════════════════════
// COMPUTE RESULTS — the "🏅 Compute Results" button. Delegates to the
// backend's compute_tournament_results_endpoint, which writes placements
// onto tournaments/{id}/division_rosters (single elimination AND cut-off).
// Safe to run repeatedly.
// ═══════════════════════════════════════════════════════════════════

function openComputeResultsModal() {
    openModal(`
        <div class="lq-modal-header">
            <h3>Compute Final Placements</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">
                Scans every category and derives the placements — from the bracket for elimination
                categories, from the round ranks for cut-off categories — then writes them onto each
                athlete's roster entry so they show up on the public tournament page and in the club
                standings. Categories whose final isn't finished yet are skipped — safe to run again later.
            </p>
            <div id="results-compute-output"></div>
            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="results-compute-btn" onclick="runComputeResults()">Compute Now</button>
                <button class="btn btn-ghost" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);
}

async function runComputeResults() {
    const btn = document.getElementById("results-compute-btn");
    const out = document.getElementById("results-compute-output");
    btn.disabled = true;
    btn.textContent = "Computing…";
    out.innerHTML = "";

    try {
        const res = await fetch(`/api/tournaments/${TOURNAMENT_ID}/results/compute`, { method: "POST" });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.detail || `Failed (${res.status})`);
        }
        const data = await res.json();

        const rows = data.results.map((r) => {
            const color = r.status === "complete" ? "var(--lq-green)" : r.status === "partial" ? "var(--lq-amber)" : "var(--lq-muted)";
            return `
                <div style="display:flex; justify-content:space-between; gap:.5rem; padding:.3rem 0; border-bottom:1px solid var(--lq-border); font-size:.82rem;">
                    <span>${escapeHtml(resolveCategoryLabel(r.categoryCode))}</span>
                    <span style="color:${color}; font-weight:700; text-transform:uppercase; text-align:right;">${escapeHtml(r.status)}${r.detail ? " — " + escapeHtml(r.detail) : ""}</span>
                </div>`;
        }).join("");

        out.innerHTML = `
            <p style="font-size:.85rem; margin-bottom:.5rem;">
                <strong>${data.categoriesProcessed}</strong> categor${data.categoriesProcessed === 1 ? "y" : "ies"} processed,
                <strong>${data.categoriesSkipped}</strong> skipped.
            </p>
            <div style="max-height:260px; overflow-y:auto;">${rows || '<p class="lq-field-hint">No categories found for this tournament yet.</p>'}</div>
            ${data.categoriesProcessed > 0 ? `
                <div class="lq-modal-actions" style="margin-top:.75rem;">
                    <button type="button" class="btn btn-ghost btn-sm" onclick="printResultsBracketsPdf(this)">🖨 Print Bracket PDFs (with Results)</button>
                    <button type="button" class="btn btn-ghost btn-sm" onclick="downloadResultsBracketsPdf(this)">⬇ Download Bracket PDFs (with Results)</button>
                </div>
                <div class="lq-modal-actions" style="margin-top:.5rem;">
                    <button type="button" class="btn btn-ghost btn-sm" onclick="openClubStandingsModal()">🏆 Club Standings</button>
                </div>
            ` : ""}
        `;
    } catch (err) {
        console.error("Compute results failed", err);
        out.innerHTML = `<div class="lq-alert-error">Failed: ${escapeHtml(err.message)}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = "Compute Now";
    }
}

// ═══════════════════════════════════════════════════════════════════
// BRACKET PDF EXPORT — the "📄 Bracket PDFs" button, the compute-results
// shortcuts and the per-category bracket buttons on rows / modals.
//
//   single elimination  built in: BracketCore re-runs the same seeded
//                       placement (or the saved slotOrder, once a bracket
//                       sync has frozen it), then every match is overlaid
//                       with its live doc (status, corners incl. replaced
//                       athletes, court, result).
//   cut-off             built in: the saved bracket doc + this category's
//                       live match docs, round by round (PR → SF → F) in
//                       running order. The scores the court saved fill
//                       the sheet's Poomsae 1 / Poomsae 2 / Total / Place
//                       columns.
//   Both are drawn by BracketSheets — the exact sheets the bracket builder
//   prints. Anything else: the discipline's sheetKinds (round robin).
// ═══════════════════════════════════════════════════════════════════

let bracketDocsByCategoryCode = {};
let reconstructedBrackets = [];   // rebuilt every time — see prepareBracketPdfData()
let sheetItems = [];              // what the 📄 Bracket PDFs modal lists — see collectSheetItems()

async function loadBracketDocsForPdf() {
    bracketDocsByCategoryCode = {};
    try {
        const snap = await fsDb.collection("tournaments").doc(TOURNAMENT_ID).collection("brackets").get();
        snap.forEach(doc => {
            const data = doc.data();
            if (data.categoryCode) bracketDocsByCategoryCode[data.categoryCode] = data;
        });
    } catch (err) {
        console.error("Failed to load bracket docs for PDF rebuild", err);
    }
}

// ageCode -> { categoryCode -> { entryId -> { placement, members } } }
async function loadDivisionRostersForPdf() {
    const rostersByAgeCode = {};
    try {
        const snap = await fsDb.collection("tournaments").doc(TOURNAMENT_ID).collection("division_rosters").get();
        snap.forEach(doc => { rostersByAgeCode[doc.id] = (doc.data() || {}).athletes || {}; });
    } catch (err) {
        console.error("Failed to load division rosters for PDF rebuild", err);
    }
    return rostersByAgeCode;
}

// ── cut-off: rounds straight from the live match docs ────────────────
const CUT_OFF_ROUND_ORDER = ["PR", "SF", "F"];

function reconstructCutOffFromFirestore(bracketDoc) {
    const matches = [];
    matchesById.forEach(m => { if (m.categoryCode === bracketDoc.categoryCode) matches.push(m); });
    if (matches.length === 0) return null;

    const byPhase = {};
    matches.forEach(m => { const p = m.roundPhase || "F"; (byPhase[p] = byPhase[p] || []).push(m); });
    const phases = [
        ...CUT_OFF_ROUND_ORDER.filter(p => byPhase[p]),
        ...Object.keys(byPhase).filter(p => !CUT_OFF_ROUND_ORDER.includes(p)),
    ];
    const rounds = phases.map(p => byPhase[p].slice()
        .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || (a.displayNumber ?? 0) - (b.displayNumber ?? 0))
        .map(m => ({ ...m, matchId: m.id })));

    // Saved entries, plus anyone on a live corner the saved list doesn't
    // have (a replaced athlete).
    const entries = (bracketDoc.entries || []).slice().sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
    const known = new Set(entries.map(e => e.entryId));
    rounds.flat().forEach(m => {
        const b = m.blue;
        if (!b || !b.entryId || known.has(b.entryId)) return;
        known.add(b.entryId);
        entries.push({ entryId: b.entryId, athleteIds: b.athleteIds, name: b.name, clubId: b.clubId, clubName: b.clubName, country: b.country });
    });

    return {
        categoryCode: bracketDoc.categoryCode,
        categoryLabel: bracketDoc.categoryLabel || bracketDoc.categoryCode,
        system: "cut_off",
        entries,
        rounds,
        bracketSize: entries.length,
        placements: {},
    };
}

function reconstructBracketFromFirestore(bracketDoc, rostersByAgeCode) {
    if (bracketDoc.system === "cut_off") return reconstructCutOffFromFirestore(bracketDoc);
    const entries = (bracketDoc.entries || []).slice().sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
    if (entries.length < 2) return null;
    if (bracketDoc.system && bracketDoc.system !== "single_elimination") return null; // round robin: sheetKinds

    // The tree as pushed — from the saved slotOrder once a bracket sync has
    // frozen it (live-queue-bracket-sync.js), else the seeded placement.
    const built = eliminationTreeFor(bracketDoc);

    const liveMatchByKey = {};
    matchesById.forEach(m => {
        if (m.categoryCode !== bracketDoc.categoryCode) return;
        if (m.bracketRound == null || m.bracketMatchNumber == null) return;
        liveMatchByKey[`${m.bracketRound}_${m.bracketMatchNumber}`] = m;
    });

    // The live match doc is the truth for who is in a slot: `replaced`
    // (old entryId → live corner) and `liveNames` (entryId → current name).
    const replaced = {};
    const liveNames = {};
    built.rounds.forEach(round => round.forEach(m => {
        if (m.status === "walkover") return;
        const live = liveMatchByKey[`${m.round}_${m.matchNumber}`];
        if (!live) {
            // Both feeders deleted (🗑 Delete Match) — this one was removed on purpose.
            if (!isEmptyCorner(m.blue) || !isEmptyCorner(m.red)) m.notInDatabase = true;
            return;
        }
        ["blue", "red"].forEach(side => {
            const was = m[side], now = live[side];
            if (!now || !now.entryId) return;
            if (now.name) liveNames[now.entryId] = now;
            if (was && was.entryId && was.entryId !== now.entryId) replaced[was.entryId] = now;
        });
        m.status = live.status;
        m.winnerEntryId = live.winnerEntryId || null;
        m.blue = live.blue || m.blue;
        m.red = live.red || m.red;
        m.courtId = live.courtId;
        m.queuePosition = live.queuePosition;
        m.displayNumber = live.displayNumber;
        m.roundPhase = live.roundPhase || m.roundPhase;
        m.win = live.win || null;
        m.win_score = live.win_score || null;
        m.win_type = live.win_type || null;
        m.poomsae = live.poomsae || null; // drawn poomsae — round labels + club sheets
    }));

    const currentEntries = entries.map(e => {
        const now = replaced[e.entryId] || liveNames[e.entryId];
        if (!now) return e;
        return {
            ...e,
            entryId: now.entryId,
            athleteIds: now.athleteIds || e.athleteIds,
            name: now.name || e.name,
            clubId: now.clubId ?? e.clubId,
            clubName: now.clubName ?? e.clubName,
            country: now.country ?? e.country,
            replacedEntryId: replaced[e.entryId] ? e.entryId : undefined,
        };
    });

    const ageCode = ageCodeForCategoryCode(bracketDoc.categoryCode);
    const rosterEntries = (ageCode && rostersByAgeCode[ageCode] && rostersByAgeCode[ageCode][bracketDoc.categoryCode]) || {};
    const placements = {};
    Object.entries(rosterEntries).forEach(([entryId, entry]) => {
        if (entry && entry.placement != null) placements[entryId] = entry.placement;
    });
    // A synced entry inherits the placement computed for the entry it replaced.
    entries.forEach(e => (e.replacedEntryIds || []).forEach(oldId => {
        if (placements[oldId] != null && placements[e.entryId] == null) placements[e.entryId] = placements[oldId];
    }));
    Object.entries(replaced).forEach(([oldId, now]) => {
        if (placements[oldId] != null && placements[now.entryId] == null) placements[now.entryId] = placements[oldId];
        delete placements[oldId];
    });

    // Slot of every entry, also under a replacing athlete's id (club sheets).
    const entrySlotIndex = { ...(built.entrySlotIndex || {}) };
    Object.entries(replaced).forEach(([oldId, now]) => {
        if (entrySlotIndex[oldId] != null && entrySlotIndex[now.entryId] == null) entrySlotIndex[now.entryId] = entrySlotIndex[oldId];
    });

    return {
        categoryCode: bracketDoc.categoryCode,
        categoryLabel: bracketDoc.categoryLabel || bracketDoc.categoryCode,
        system: "single_elimination",
        entrySlotIndex,
        entries: currentEntries,
        rounds: built.rounds,
        bracketSize: built.bracketSize,
        placements,
    };
}

async function prepareBracketPdfData() {
    const [, , rostersByAgeCode] = await Promise.all([
        loadBracketDocsForPdf(),
        BracketSheets.prepareAssets(),
        loadDivisionRostersForPdf(),
    ]);
    reconstructedBrackets = Object.values(bracketDocsByCategoryCode)
        .map(bracketDoc => reconstructBracketFromFirestore(bracketDoc, rostersByAgeCode))
        .filter(Boolean)
        .sort((a, b) => compareCategories(a.categoryCode, a.categoryLabel, b.categoryCode, b.categoryLabel));
}

// Same numbering as the bracket builder: poomsae "001", kyorugi "101".
const MATCH_NUMBER_PAD = String(DISCIPLINE).toLowerCase().includes("poomsae") ? 3 : 0;
// Order of every sheet list / print / PDF. Poomsae: by the category's
// first match number (001, 002…), so the sheets come out in the order the
// categories run — numbers interleave across courts, so this is event order.
// A category without numbered matches goes last. Kyorugi: by label, as before.
function firstMatchNumberOf(categoryCode) {
    let min = Infinity;
    matchesById.forEach(m => {
        if (m.categoryCode === categoryCode && typeof m.displayNumber === "number" && m.displayNumber < min) min = m.displayNumber;
    });
    return min;
}

function compareCategories(codeA, labelA, codeB, labelB) {
    if (MATCH_NUMBER_PAD) {
        const a = firstMatchNumberOf(codeA), b = firstMatchNumberOf(codeB);
        if (a !== b) return a === Infinity ? 1 : b === Infinity ? -1 : a - b;
    }
    return String(labelA).localeCompare(String(labelB));
}

const BRACKET_SHEET_OPTIONS = {
    title: TOURNAMENT_TITLE,
    formatNumber: m => (m.displayNumber == null ? "" : MATCH_NUMBER_PAD ? String(m.displayNumber).padStart(MATCH_NUMBER_PAD, "0") : String(m.displayNumber)),
};

// ── Sheets of every system (call prepareBracketPdfData() first) ─────
// -> [{kind: "bracket", code, label, bracket} | {kind: <sheetKind>, code, label, …}]
async function collectSheetItems() {
    const items = reconstructedBrackets.map(b => ({ kind: "bracket", code: b.categoryCode, label: b.categoryLabel, bracket: b }));
    const seen = new Set(items.map(i => i.code));
    for (const sk of LQ.sheetKinds) {
        const found = (await sk.collect(bracketDocsByCategoryCode)) || [];
        found.forEach(i => {
            if (seen.has(i.code)) return;
            seen.add(i.code);
            items.push({ ...i, kind: sk.kind });
        });
    }
    items.sort((a, b) => compareCategories(a.code, a.label, b.code, b.label));
    return items;
}

// Prints items of any kind: single-elimination brackets via BracketSheets,
// the rest via the matching kind module (sheetKinds or resultKinds).
async function printItems(items, kinds) {
    const brackets = items.filter(i => i.kind === "bracket").map(i => i.bracket);
    if (brackets.length) await BracketSheets.print(brackets, BRACKET_SHEET_OPTIONS);
    for (const k of kinds) {
        const mine = items.filter(i => i.kind === k.kind);
        if (mine.length) await k.print(mine);
    }
}

// One PDF per kind: "<base>.pdf" when there's only one, else
// "<base>_<suffix>.pdf" each.
async function downloadItems(items, kinds, baseName) {
    const groups = [];
    const brackets = items.filter(i => i.kind === "bracket").map(i => i.bracket);
    if (brackets.length) groups.push({ suffix: "brackets", run: (f) => BracketSheets.downloadPdf(brackets, f, BRACKET_SHEET_OPTIONS) });
    for (const k of kinds) {
        const mine = items.filter(i => i.kind === k.kind);
        if (!mine.length) continue;
        if (!k.download) throw new Error(`${k.title || k.kind} can't be downloaded as a PDF.`);
        groups.push({ suffix: k.fileSuffix || k.kind, run: (f) => k.download(mine, f) });
    }
    if (!groups.length) throw new Error("Nothing to download.");
    for (const g of groups) await g.run(groups.length === 1 ? `${baseName}.pdf` : `${baseName}_${g.suffix}.pdf`);
}

function safeFilePart(str, fallback) {
    return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || fallback;
}

function tournamentFileBase() {
    return safeFilePart(TOURNAMENT_TITLE, "tournament");
}

// Disables the button while fn runs, alerts on failure, restores it.
async function runWithButton(btn, busyLabel, fn) {
    const original = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.textContent = busyLabel; }
    try {
        await fn();
        return true;
    } catch (err) {
        console.error(err);
        alert(err.message || "Failed — try again.");
        return false;
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
}

function sheetKindTitle(item) {
    if (item.kind === "bracket") return item.bracket.system === "cut_off" ? "Cut-off" : "Elimination";
    const k = LQ.sheetKinds.find(s => s.kind === item.kind);
    return (k && k.title) || item.kind;
}

// ── Printing through a hidden iframe ─────────────────────────────────
// Every "generate something then print it" on this page goes through
// here: write the HTML, wait for any images to decode, settle briefly,
// print. Off-screen with REAL dimensions so the engine actually paints.
function createHiddenPrintIframe() {
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.top = "-10000px";
    iframe.style.left = "-10000px";
    iframe.style.width = "1200px";
    iframe.style.height = "1600px";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
    return iframe;
}

function printHtmlInFrame(bodyHtml, opts) {
    opts = opts || {};
    const imgSizeCss = opts.pageSizeMm
        ? `width: ${opts.pageSizeMm.width}mm; height: ${opts.pageSizeMm.height}mm;`
        : `width: 100%;`;
    const pageSizeCss = opts.pageSizeMm
        ? `size: ${opts.pageSizeMm.width}mm ${opts.pageSizeMm.height}mm;`
        : (opts.landscape ? "size: landscape;" : "");

    return new Promise((resolve, reject) => {
        const iframe = createHiddenPrintIframe();
        const cleanup = () => {
            setTimeout(() => {
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            }, 1000);
        };

        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(`<!DOCTYPE html><html><head><style>
                html, body { margin: 0; padding: 0; }
                img { ${imgSizeCss} display: block; page-break-after: always; page-break-inside: avoid; }
                img:last-child { page-break-after: auto; }
                @page { margin: 0;${pageSizeCss ? " " + pageSizeCss : ""} }
            </style></head><body>${bodyHtml}</body></html>`);
        doc.close();

        const images = [...doc.images];
        const whenReady = images.length === 0
            ? Promise.resolve()
            : Promise.all(images.map(img => img.complete
                ? Promise.resolve()
                : new Promise(res => { img.onload = res; img.onerror = res; })));

        whenReady
            .then(() => new Promise(res => setTimeout(res, 100))) // borders paint late — settle first
            .then(() => {
                try {
                    iframe.contentWindow.focus();
                    iframe.contentWindow.print();
                    resolve();
                } catch (e) {
                    reject(e);
                } finally {
                    cleanup();
                }
            });
    });
}

function printImageDataUrl(dataUrl) {
    return printHtmlInFrame(`<img src="${dataUrl}">`);
}

async function openBracketPdfModal() {
    openModal(`
        <div class="lq-modal-header">
            <h3>Bracket Sheets (PDF)</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">
                Every category's sheet — the same sheets the bracket builder prints — rebuilt live from
                what's currently saved. Elimination: every match's corners and result; the Classification
                box is filled in once 🏅 Compute Results has run. Cut-off: each round's running order with
                every saved score and place written in. Round robin: every bout and the standings.
            </p>
            <div id="bracket-pdf-list"><p class="lq-field-hint">Loading brackets…</p></div>
            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="bracket-pdf-print-all-btn" onclick="printAllBracketsPDF()" disabled>🖨 Print All</button>
                <button class="btn btn-ghost" id="bracket-pdf-download-btn" onclick="downloadAllBracketsPDF()" disabled>⬇ Download PDF</button>
                <button class="btn btn-ghost" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);

    try {
        await prepareBracketPdfData();
        sheetItems = await collectSheetItems();
    } catch (err) {
        console.error("Failed to build sheets", err);
        sheetItems = [];
        const el = document.getElementById("bracket-pdf-list");
        if (el) el.innerHTML = `<div class="lq-alert-error">Couldn't build the sheets: ${escapeHtml(err.message)}</div>`;
        return;
    }

    const listEl = document.getElementById("bracket-pdf-list");
    if (!listEl) return; // modal was closed while loading

    if (sheetItems.length === 0) {
        listEl.innerHTML = `<p class="lq-field-hint">No categories with pushed brackets for this tournament yet.</p>`;
        return;
    }

    document.getElementById("bracket-pdf-print-all-btn").disabled = false;
    document.getElementById("bracket-pdf-download-btn").disabled = false;
    listEl.innerHTML = sheetItems.map((item, i) => {
        const missing = item.kind === "bracket" && item.bracket.rounds.some(r => r.some(m => m.notInDatabase));
        return `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:.5rem; padding:.4rem 0; border-bottom:1px solid var(--lq-border); font-size:.85rem;">
                <span>${escapeHtml(item.label)}
                    <span style="color:var(--lq-muted); font-size:.75rem;"> · ${escapeHtml(sheetKindTitle(item))}</span>
                    ${missing ? ` <span style="color:var(--lq-amber);">· some matches missing from DB</span>` : ""}</span>
                <span style="display:flex; gap:.35rem; flex-shrink:0;">
                    <button type="button" class="btn btn-ghost btn-sm" onclick="printSheetItemAt(${i}, this)">🖨 Print</button>
                    <button type="button" class="btn btn-ghost btn-sm" onclick="downloadSheetItemAt(${i}, this)">⬇ PDF</button>
                </span>
            </div>
        `;
    }).join("");
}

function printSheetItemAt(index, btnEl) {
    const item = sheetItems[index];
    if (!item) return;
    return runWithButton(btnEl, "Printing…", () => printItems([item], LQ.sheetKinds));
}

function downloadSheetItemAt(index, btnEl) {
    const item = sheetItems[index];
    if (!item) return;
    return runWithButton(btnEl, "Building…", () =>
        downloadItems([item], LQ.sheetKinds, `${tournamentFileBase()}_${safeFilePart(item.label, item.code)}`));
}

function printAllBracketsPDF() {
    return runWithButton(document.getElementById("bracket-pdf-print-all-btn"), "Printing…", () => {
        if (sheetItems.length === 0) throw new Error("No sheets to print.");
        return printItems(sheetItems, LQ.sheetKinds);
    });
}

function downloadAllBracketsPDF() {
    return runWithButton(document.getElementById("bracket-pdf-download-btn"), "Building…", () =>
        downloadItems(sheetItems, LQ.sheetKinds, `${tournamentFileBase()}_brackets`));
}

// Shortcuts from the 🏅 Compute Results modal.
function printResultsBracketsPdf(btnEl) {
    return runWithButton(btnEl, "Printing…", async () => {
        await prepareBracketPdfData();
        const items = await collectSheetItems();
        if (items.length === 0) throw new Error("No sheets to print.");
        await printItems(items, LQ.sheetKinds);
    });
}

function downloadResultsBracketsPdf(btnEl) {
    return runWithButton(btnEl, "Building…", async () => {
        await prepareBracketPdfData();
        const items = await collectSheetItems();
        await downloadItems(items, LQ.sheetKinds, `${tournamentFileBase()}_brackets`);
    });
}

// ── One category's sheet — row buttons and match modals ──────────────
async function sheetItemForCategory(categoryCode) {
    await prepareBracketPdfData();
    const item = (await collectSheetItems()).find(i => i.code === categoryCode);
    if (!item) throw new Error(`No bracket for ${resolveCategoryLabel(categoryCode)} yet — push its brackets first.`);
    return item;
}

function printCategorySheet(categoryCode, btnEl, busyLabel) {
    return runWithButton(btnEl, busyLabel || "…", async () =>
        printItems([await sheetItemForCategory(categoryCode)], LQ.sheetKinds));
}

function downloadCategorySheet(categoryCode, btnEl, busyLabel) {
    return runWithButton(btnEl, busyLabel || "…", async () => {
        const item = await sheetItemForCategory(categoryCode);
        await downloadItems([item], LQ.sheetKinds, `${tournamentFileBase()}_${safeFilePart(item.label, categoryCode)}`);
    });
}

function categorySheetButtonsHtml(categoryCode) {
    const code = escapeAttr(categoryCode || "");
    return `
        <button class="btn btn-ghost" onclick="printCategorySheet('${code}', this, 'Printing…')">🖨 Bracket</button>
        <button class="btn btn-ghost" onclick="downloadCategorySheet('${code}', this, 'Building…')">⬇ Bracket PDF</button>`;
}

// ═══════════════════════════════════════════════════════════════════
// CLUB SHEETS — the "👥 Club Sheets" button: the bracket builder's own
// club sheet (BracketSheets.downloadClubSheets), from what's saved now —
// one page per club, every entrant with the match numbers of every match
// they can have: elimination "B 308" per R32 … F, cut-off per
// Preliminary / Semi-Final / Final (filled in once they've qualified into
// a round), round robin every bout.
// ═══════════════════════════════════════════════════════════════════

// Round robin has no draw sheet, so it isn't in reconstructedBrackets —
// built here for the club sheet only.
function roundRobinBracketsForClubSheets() {
    return Object.values(bracketDocsByCategoryCode)
        .filter(doc => doc.system === "round_robin")
        .map(doc => {
            const matches = [];
            matchesById.forEach(m => { if (m.categoryCode === doc.categoryCode) matches.push(m); });
            matches.sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
            const entries = (doc.entries || []).slice();
            const known = new Set(entries.map(e => e.entryId));
            matches.forEach(m => ["blue", "red"].forEach(side => {
                const c = m[side];
                if (c && c.entryId && !known.has(c.entryId)) { known.add(c.entryId); entries.push({ ...c }); }
            }));
            return { categoryCode: doc.categoryCode, categoryLabel: doc.categoryLabel || doc.categoryCode, system: "round_robin", entries, rounds: [matches] };
        });
}

function downloadLiveClubSheets(btnEl) {
    return runWithButton(btnEl, "Building…", async () => {
        await prepareBracketPdfData();
        const brackets = [...reconstructedBrackets, ...roundRobinBracketsForClubSheets()]
            .sort((a, b) => compareCategories(a.categoryCode, a.categoryLabel, b.categoryCode, b.categoryLabel));
        if (brackets.length === 0) throw new Error("No pushed brackets for this tournament yet.");
        await BracketSheets.downloadClubSheets(brackets, `${tournamentFileBase()}_club_sheets.pdf`, BRACKET_SHEET_OPTIONS);
    });
}

// ═══════════════════════════════════════════════════════════════════
// PRINT NEW RESULTS — prints every category whose result is FINISHED
// and hasn't been printed yet, and reprints one whose result changed
// since (a corrected score, a replaced athlete).
//
//   single elimination  built in here: the bracket sheet with results +
//                       Classification, once the Final is decided
//   cut-off             built in here: the cut-off sheet with every score
//                       and place written in, once the Final is over
//   anything else       the discipline's resultKinds (round-robin standings)
//
// MEMORY: tournaments/{id}/meta/printedResults →
//   { categories: { categoryCode: { fingerprint, printedAt, label } } }
// shared by every computer; localStorage if Firestore refuses the write.
// ═══════════════════════════════════════════════════════════════════

const PRINTED_RESULTS_LOCAL_KEY = `truevar.printedResults.${TOURNAMENT_ID}`;

function printedResultsRef() {
    return fsDb.collection("tournaments").doc(TOURNAMENT_ID).collection("meta").doc("printedResults");
}

async function loadPrintedResults() {
    let remote = {}, local = {};
    try {
        const doc = await printedResultsRef().get();
        remote = (doc.exists && doc.data().categories) || {};
    } catch (err) {
        console.warn("printedResults not readable from Firestore — using this browser's memory", err);
    }
    try { local = JSON.parse(localStorage.getItem(PRINTED_RESULTS_LOCAL_KEY) || "{}") || {}; } catch (e) { /* none */ }
    return { ...local, ...remote };
}

// -> "firestore" | "local"
async function savePrintedResults(updates) {
    try {
        const merged = { ...JSON.parse(localStorage.getItem(PRINTED_RESULTS_LOCAL_KEY) || "{}"), ...updates };
        localStorage.setItem(PRINTED_RESULTS_LOCAL_KEY, JSON.stringify(merged));
    } catch (e) { /* storage unavailable */ }
    try {
        await printedResultsRef().set({ categories: updates }, { merge: true });
        return "firestore";
    } catch (err) {
        console.warn("printedResults not writable in Firestore — remembered in this browser only", err);
        return "local";
    }
}

// Small, stable string hash (djb2) — only used to notice change.
function fingerprintOf(value) {
    const str = JSON.stringify(value);
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

// Plain printable results page (title, category, bordered table).
function resultsTablePageHtml(label, headers, rowsHtml, note) {
    const th = (h) => `<th style="border:1px solid #111; padding:5px 7px; font-weight:700; text-align:${h.left ? "left" : "center"};">${escapeHtml(h.label)}</th>`;
    return `
        <div style="font-family: Arial, Helvetica, sans-serif; padding: 24px; box-sizing: border-box; color: #111; page-break-after: always;">
            <div style="font-size: 20px; font-weight: 700;">${escapeHtml(TOURNAMENT_TITLE || "Tournament")}</div>
            <div style="font-size: 16px; font-weight: 700; margin: 4px 0 16px;">${escapeHtml(label)} — Results</div>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead><tr>${headers.map(th).join("")}</tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
            ${note ? `<div style="font-size: 11px; color: #333; margin-top: 8px;">${note}</div>` : ""}
            <div style="font-size: 10px; color: #555; margin-top: 8px;">Printed ${escapeHtml(new Date().toLocaleString())}</div>
        </div>`;
}

function resultCellHtml(content, extra) {
    return `<td style="border:1px solid #111; padding:5px 7px; ${extra || "text-align:center;"}">${content}</td>`;
}

// ── single elimination ───────────────────────────────────────────────
function isBracketFinished(bracket) {
    if (bracket.system === "cut_off") {
        const final = bracket.rounds[bracket.rounds.length - 1] || [];
        return final.length > 0 && final.every(m => m.status === "completed" || NOT_PERFORMED.has(m.status) || (m.blue && m.blue.empty));
    }
    const lastRound = bracket.rounds[bracket.rounds.length - 1] || [];
    const final = lastRound[0];
    if (!final) return false;
    if (final.status === "walkover") return true;
    return isDone(final) && !final.notInDatabase;
}

function bracketFingerprint(bracket) {
    return fingerprintOf({
        placements: bracket.placements,
        rounds: bracket.rounds.map(r => r.map(m => [
            m.matchId, m.status, m.winnerEntryId || null, m.win || null, m.win_score || null, m.win_type || null,
            m.blue && m.blue.name || null, m.red && m.red.name || null,
            m.blue && m.blue.finalScore != null ? m.blue.finalScore : null, m.rank ?? null, m.qualified ?? null,
        ])),
    });
}

// ── the button ───────────────────────────────────────────────────────
async function collectFinishedResults() {
    let computeNote = null;
    try {
        const res = await fetch(`/api/tournaments/${TOURNAMENT_ID}/results/compute`, { method: "POST" });
        if (!res.ok) computeNote = `Placements not recomputed (${res.status}) — printed as last computed.`;
    } catch (err) {
        computeNote = "Placements not recomputed (offline?) — printed as last computed.";
    }
    await prepareBracketPdfData(); // bracket docs + rosters + live matches → reconstructedBrackets

    const finished = [];
    reconstructedBrackets.filter(isBracketFinished).forEach(b => {
        finished.push({ kind: "bracket", code: b.categoryCode, label: b.categoryLabel, bracket: b, fingerprint: bracketFingerprint(b) });
    });
    for (const rk of LQ.resultKinds) {
        const items = await rk.collect(bracketDocsByCategoryCode);
        (items || []).forEach(i => finished.push({ ...i, kind: rk.kind }));
    }
    finished.sort((a, b) => compareCategories(a.code, a.label, b.code, b.label));
    return { finished, computeNote };
}

function printResultItems(items) {
    return printItems(items, LQ.resultKinds);
}

async function printNewResults() {
    const btn = document.getElementById("print-new-results-btn");
    const label = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    try {
        const [{ finished, computeNote }, printed] = await Promise.all([collectFinishedResults(), loadPrintedResults()]);
        const fresh = finished.filter(i => !printed[i.code]);
        const changed = finished.filter(i => printed[i.code] && printed[i.code].fingerprint !== i.fingerprint);
        const toPrint = [...fresh, ...changed];

        if (toPrint.length === 0) {
            showNewResultsSummary({ printed: [], finished, printedBefore: printed, computeNote, storage: null });
            return;
        }
        if (btn) btn.textContent = "Printing…";
        await printResultItems(toPrint);
        const now = new Date().toISOString();
        const storage = await savePrintedResults(Object.fromEntries(toPrint.map(i => [i.code, { fingerprint: i.fingerprint, printedAt: now, label: i.label }])));
        showNewResultsSummary({ printed: toPrint, changedCodes: new Set(changed.map(i => i.code)), finished, printedBefore: printed, computeNote, storage });
    } catch (err) {
        console.error("Print new results failed", err);
        alert(err.message || "Failed to print — try again.");
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
}

// "Print everything again" — for a lost or jammed printout.
async function reprintAllResults(btnEl) {
    const ok = await runWithButton(btnEl, "Printing…", async () => {
        const { finished } = await collectFinishedResults();
        if (finished.length === 0) throw new Error("No finished categories yet.");
        await printResultItems(finished);
        const now = new Date().toISOString();
        await savePrintedResults(Object.fromEntries(finished.map(i => [i.code, { fingerprint: i.fingerprint, printedAt: now, label: i.label }])));
    });
    if (ok) closeModal();
}

// Every finished category's results as PDF files (doesn't mark anything printed).
function downloadAllResults(btnEl) {
    return runWithButton(btnEl, "Building…", async () => {
        const { finished } = await collectFinishedResults();
        if (finished.length === 0) throw new Error("No finished categories yet.");
        await downloadItems(finished, LQ.resultKinds, `${tournamentFileBase()}_results`);
    });
}

function showNewResultsSummary({ printed, changedCodes, finished, printedBefore, computeNote, storage }) {
    const last = Object.values(printedBefore).map(p => p.printedAt).filter(Boolean).sort().pop();
    const list = printed.map(i => `
        <div style="display:flex; justify-content:space-between; gap:.5rem; padding:.3rem 0; border-bottom:1px solid var(--lq-border); font-size:.85rem;">
            <span>${escapeHtml(i.label)}</span>
            <span style="color:${changedCodes && changedCodes.has(i.code) ? "var(--lq-amber)" : "var(--lq-green)"}; font-weight:700;">
                ${changedCodes && changedCodes.has(i.code) ? "CORRECTED" : "NEW"}</span>
        </div>`).join("");
    openModal(`
        <div class="lq-modal-header">
            <h3>${printed.length ? `Printed ${printed.length} result${printed.length === 1 ? "" : "s"}` : "No new results"}</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            ${printed.length ? `<div style="max-height:260px; overflow-y:auto; margin-bottom:.75rem;">${list}</div>`
            : `<p class="lq-field-hint">Nothing finished since the last print${last ? ` (${escapeHtml(new Date(last).toLocaleString())})` : ""}. ${finished.length} finished categor${finished.length === 1 ? "y has" : "ies have"} already been printed.</p>`}
            ${computeNote ? `<div class="lq-alert-error" style="margin-bottom:.5rem;">${escapeHtml(computeNote)}</div>` : ""}
            ${storage === "local" ? `<div class="lq-alert-error" style="margin-bottom:.5rem;">Couldn't save to Firestore — only THIS browser remembers what was printed.</div>` : ""}
            <div class="lq-modal-actions">
                <button class="btn btn-ghost" onclick="reprintAllResults(this)">Print everything again</button>
                <button class="btn btn-ghost" onclick="downloadAllResults(this)">⬇ Download all results</button>
                <button class="btn btn-primary" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);
}

// ═══════════════════════════════════════════════════════════════════
// CLUB STANDINGS — the "🏆 Club Standings" button. Tallies every club's
// 1st/2nd/3rd places (division_rosters "placement"), won matches (every
// decided duel in matchesById) and athletes who were alone in their
// category, weighted by the points chosen. Ties share a place (1, 1, 3).
//
// Alone in a category: they get the "alone" points INSTEAD of 1st-place
// points (no one to beat) — even if Compute Results gave them 1st.
// Poomsae cut-off has no won matches, so that field / column only shows
// when the tournament has head-to-head bouts (kyorugi, side by side).
// ═══════════════════════════════════════════════════════════════════

const IS_POOMSAE = String(DISCIPLINE).toLowerCase().includes("poomsae");

// Head-to-head bouts only — a cut-off performance has no red corner.
function hasDuelMatches() {
    for (const m of matchesById.values()) if (m.red && (m.red.entryId || m.red.source)) return true;
    return false;
}

function openClubStandingsModal() {
    const showWon = hasDuelMatches();
    openModal(`
        <div class="lq-modal-header">
            <h3>Club Standings (PDF)</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">
                Ranks every club by a weighted score: 1st/2nd/3rd-place finishes (from 🏅 Compute Results)${showWon ? ", won matches" : ""}
                and athletes who were alone in their category, each worth the points you set below. An athlete alone
                in a category gets only the "alone" points, not 1st-place points. Ties share the same place.
            </p>
            <div class="lq-detail-grid">
                <label>Points per 1st <input type="number" id="cs-pts-first" value="7" step="any"></label>
                <label>Points per 2nd <input type="number" id="cs-pts-second" value="3" step="any"></label>
                <label>Points per 3rd <input type="number" id="cs-pts-third" value="1" step="any"></label>
                <label>Points when alone in category <input type="number" id="cs-pts-alone" value="${IS_POOMSAE ? 3 : 0}" step="any"></label>
                ${showWon ? `<label>Points per won match <input type="number" id="cs-pts-won" value="${IS_POOMSAE ? 0 : 1}" step="any"></label>` : ""}
            </div>
            <div id="club-standings-error" class="lq-alert-error hidden"></div>
            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="club-standings-print-btn" onclick="printClubStandingsPdf()">🖨 Print</button>
                <button class="btn btn-ghost" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);
}

async function loadRegisteredClubsForStandings() {
    const clubNameById = {};
    try {
        const doc = await fsDb.collection("tournaments").doc(TOURNAMENT_ID).collection("meta").doc("registeredClubs").get();
        const data = doc.exists ? doc.data() : {};
        Object.entries(data || {}).forEach(([clubId, info]) => { clubNameById[clubId] = (info && info.clubName) || clubId; });
    } catch (err) {
        console.error("Failed to load registered clubs for standings", err);
    }
    return clubNameById;
}

async function printClubStandingsPdf() {
    const errEl = document.getElementById("club-standings-error");
    errEl.classList.add("hidden");

    const num = id => { const el = document.getElementById(id); return el ? Number(el.value) || 0 : 0; };
    const ptsFirst = num("cs-pts-first");
    const ptsSecond = num("cs-pts-second");
    const ptsThird = num("cs-pts-third");
    const ptsAlone = num("cs-pts-alone");
    const showWon = !!document.getElementById("cs-pts-won");
    const ptsWon = num("cs-pts-won");

    const btn = document.getElementById("club-standings-print-btn");
    btn.disabled = true;
    btn.textContent = "Printing…";

    try {
        const [rostersByAgeCode, clubNameById] = await Promise.all([
            loadDivisionRostersForPdf(),
            loadRegisteredClubsForStandings(),
        ]);

        const tally = {};
        const bump = (clubId, field, amount) => {
            if (!clubId) return;
            const row = tally[clubId] || (tally[clubId] = { first: 0, second: 0, third: 0, alone: 0, wonFights: 0 });
            row[field] += amount;
        };
        const clubOf = entry => (entry && entry.members && entry.members[0] ? entry.members[0].clubId : null);

        Object.values(rostersByAgeCode).forEach(categoriesForAge => {
            Object.values(categoriesForAge).forEach(entriesForCategory => {
                const entries = Object.values(entriesForCategory || {});
                if (entries.length === 1) {
                    bump(clubOf(entries[0]), "alone", 1); // alone — not counted as a 1st
                    return;
                }
                entries.forEach(entry => {
                    if (entry.placement === 1) bump(clubOf(entry), "first", 1);
                    else if (entry.placement === 2) bump(clubOf(entry), "second", 1);
                    else if (entry.placement === 3) bump(clubOf(entry), "third", 1);
                });
            });
        });

        if (showWon) {
            matchesById.forEach(m => {
                if (!m.winnerEntryId || m.status === "walkover") return; // a walkover isn't a won fight
                const winnerCorner = m.blue && m.blue.entryId === m.winnerEntryId ? m.blue
                    : m.red && m.red.entryId === m.winnerEntryId ? m.red
                        : null;
                if (winnerCorner && winnerCorner.clubId) bump(winnerCorner.clubId, "wonFights", 1);
            });
        }

        const rows = Object.entries(tally).map(([clubId, counts]) => ({
            clubId,
            clubName: clubNameById[clubId] || clubId,
            ...counts,
            points: counts.first * ptsFirst + counts.second * ptsSecond + counts.third * ptsThird
                + counts.alone * ptsAlone + (showWon ? counts.wonFights * ptsWon : 0),
        })).filter(r => r.first || r.second || r.third || r.alone || (showWon && r.wonFights));

        if (rows.length === 0) {
            errEl.textContent = "Nothing to rank yet — run 🏅 Compute Results first.";
            errEl.classList.remove("hidden");
            return;
        }

        rows.sort((a, b) => b.points - a.points || a.clubName.localeCompare(b.clubName));
        let place = 0;
        rows.forEach((r, i) => {
            if (i === 0 || r.points !== rows[i - 1].points) place = i + 1;
            r.place = place;
        });

        await printHtmlInFrame(buildClubStandingsHtml(rows, { showWon }));
        closeModal();
    } catch (err) {
        console.error("Failed to print club standings PDF", err);
        errEl.textContent = err.message || "Failed to print — try again.";
        errEl.classList.remove("hidden");
    } finally {
        btn.disabled = false;
        btn.textContent = "🖨 Print";
    }
}

function buildClubStandingsHtml(rows, opts) {
    const showWon = !opts || opts.showWon !== false;
    const cell = (content, extra) => `<td style="border:1px solid #111; padding:6px 8px; ${extra || "text-align:center;"}">${content}</td>`;
    const rowsHtml = rows.map(r => `
        <tr>
            ${cell(escapeHtml(String(r.place)))}
            ${cell(escapeHtml(r.clubName), "text-align:left;")}
            ${cell(r.first)}
            ${cell(r.second)}
            ${cell(r.third)}
            ${cell(r.alone)}
            ${showWon ? cell(r.wonFights) : ""}
            ${cell(r.points)}
        </tr>
    `).join("");

    const th = (label, extra) => `<th style="border:1px solid #111; padding:6px 8px; font-weight:700; ${extra || "text-align:center;"}">${escapeHtml(label)}</th>`;

    return `
        <div style="font-family: Arial, Helvetica, sans-serif; padding: 24px; box-sizing: border-box; color: #111;">
            <div style="font-size: 20px; font-weight: 700;">${escapeHtml(TOURNAMENT_TITLE || "Tournament")}</div>
            <div style="font-size: 16px; font-weight: 700; margin: 4px 0 16px;">Club Standings</div>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr>
                        ${th("Place")}
                        ${th("Club", "text-align:left;")}
                        ${th("1st")}
                        ${th("2nd")}
                        ${th("3rd")}
                        ${th("Alone")}
                        ${showWon ? th("Won Matches") : ""}
                        ${th("Points")}
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════════════
// INSERT MATCH — the "+" between two rows. Creates a new match doc
// slotted exactly there; display number <base>.<n> after the previous
// match (101 → 101.1 → 101.2). Discipline fields via LQ.insert. When the
// discipline allows a missing red corner (poomsae), leaving red empty
// creates a solo performance.
// ═══════════════════════════════════════════════════════════════════

let insertPendingCorners = { blue: null, red: null };
let insertSearchTimers = { blue: null, red: null };
let insertSearchResults = { blue: [], red: [] };

function computeInsertDisplayNumber(prevMatch, nextMatch) {
    if (prevMatch && prevMatch.displayNumber != null) {
        const prev = prevMatch.displayNumber;
        const base = Math.floor(prev);
        const decimalDigit = Math.round((prev - base) * 10);
        return Number((base + (decimalDigit + 1) / 10).toFixed(1));
    }
    if (nextMatch && nextMatch.displayNumber != null) {
        return Number((nextMatch.displayNumber - 0.1).toFixed(1));
    }
    return null;
}

function computeInsertQueuePosition(prevMatch, nextMatch) {
    const prevQ = prevMatch ? prevMatch.queuePosition : null;
    const nextQ = nextMatch ? nextMatch.queuePosition : null;
    if (prevQ != null && nextQ != null) return (prevQ + nextQ) / 2;
    if (prevQ != null) return prevQ + 1;
    if (nextQ != null) return nextQ - 1;
    return 0;
}

function openInsertModal(courtId, prevMatch, nextMatch) {
    insertPendingCorners = { blue: null, red: null };
    insertSearchResults = { blue: [], red: [] };
    const ins = LQ.insert;

    const categoriesPresent = new Map();
    matchesById.forEach((m) => {
        if (m.categoryCode) categoriesPresent.set(m.categoryCode, resolveCategoryLabel(m.categoryCode));
    });
    const categoryOptionsHtml = [...categoriesPresent.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([code, label]) => `<option value="${escapeAttr(code)}">${escapeHtml(label)}</option>`)
        .join("");

    const prevLabel = prevMatch ? `#${prevMatch.displayNumber}` : "the start of this court";
    const nextLabel = nextMatch ? `#${nextMatch.displayNumber}` : "the end of this court";

    openModal(`
        <div class="lq-modal-header">
            <h3>Insert Match</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">
                Inserting on <strong>${escapeHtml(courtId)}</strong>, between ${escapeHtml(prevLabel)} and ${escapeHtml(nextLabel)}.
                It gets its own number so nothing else gets renumbered.
                ${ins.requiresRed ? "" : "Leave Red empty for a solo performance."}
            </p>

            <div class="lq-detail-corners">
                <div class="lq-detail-corner blue">
                    <label>Blue Corner</label>
                    <div class="lq-corner-current" id="insert-corner-current-blue">— none picked —</div>
                    <input type="search" id="insert-corner-search-blue" class="lq-text-input" placeholder="Search athlete…" autocomplete="off">
                    <div id="insert-corner-results-blue" class="lq-athlete-results"></div>
                </div>
                <div class="lq-detail-corner red">
                    <label>Red Corner${ins.requiresRed ? "" : " (optional)"}</label>
                    <div class="lq-corner-current" id="insert-corner-current-red">— none picked —</div>
                    <input type="search" id="insert-corner-search-red" class="lq-text-input" placeholder="Search athlete…" autocomplete="off">
                    <div id="insert-corner-results-red" class="lq-athlete-results"></div>
                </div>
            </div>

            <div class="lq-form-field">
                <label style="display:block; font-size:.72rem; font-weight:700; color:var(--lq-muted); text-transform:uppercase; margin-bottom:.3rem;">Category</label>
                <select id="insert-category">
                    ${categoryOptionsHtml}
                    <option value="__custom__">Other / exhibition category…</option>
                </select>
                <div id="insert-category-custom" class="hidden" style="display:flex; gap:.5rem; margin-top:.5rem;">
                    <input type="text" id="insert-category-code" placeholder="categoryCode e.g. exhibition_open" class="lq-text-input">
                    <input type="text" id="insert-category-label" placeholder="Label e.g. Exhibition · Open" class="lq-text-input">
                </div>
            </div>

            <div class="lq-detail-grid" style="margin-top:1rem;">
                <label>Round Phase
                    <select id="insert-roundPhase">
                        ${ins.roundPhases.slice().reverse().map(p => `<option value="${p}">${p}</option>`).join("")}
                    </select>
                </label>
                <label>&nbsp;</label>
                ${ins.fieldsHtml()}
                <label class="lq-checkbox-label lq-span-2">
                    <input type="checkbox" id="insert-isRanked">
                    Ranked / official (counts toward standings) — off by default for inserted matches.
                    A ranked solo performance in a cut-off category is also added to that category's bracket.
                </label>
            </div>

            <div id="insert-error" class="lq-alert-error hidden"></div>

            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="insert-submit-btn">Create Match</button>
                ${(ins.actions || []).map(a => `<button class="btn btn-ghost" id="insert-action-${escapeAttr(a.id)}">${a.label}</button>`).join("")}
                <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
            </div>
        </div>
    `);

    wireInsertCornerSearch("blue");
    wireInsertCornerSearch("red");

    // Category and round default to the neighbouring match's; picking
    // another category picks the round its latest match is in.
    const categorySelect = document.getElementById("insert-category");
    const phaseSelect = document.getElementById("insert-roundPhase");
    const setPhase = (phase) => {
        if (!phase) return;
        if (![...phaseSelect.options].some(o => o.value === phase)) {
            phaseSelect.insertAdjacentHTML("afterbegin", `<option value="${escapeAttr(phase)}">${escapeHtml(phase)}</option>`);
        }
        phaseSelect.value = phase;
    };
    const latestPhaseOf = (code) => {
        let latest = null;
        matchesById.forEach(m => {
            if (m.categoryCode === code && (!latest || (m.queuePosition ?? 0) > (latest.queuePosition ?? 0))) latest = m;
        });
        return latest && latest.roundPhase;
    };
    const anchor = [prevMatch, nextMatch].find(x => x && x.categoryCode && categoriesPresent.has(x.categoryCode));
    if (anchor) {
        categorySelect.value = anchor.categoryCode;
        setPhase(anchor.roundPhase);
    } else if (categorySelect.value && categorySelect.value !== "__custom__") {
        setPhase(latestPhaseOf(categorySelect.value));
    }
    categorySelect.onchange = () => {
        const v = categorySelect.value;
        document.getElementById("insert-category-custom").classList.toggle("hidden", v !== "__custom__");
        if (v !== "__custom__") setPhase(latestPhaseOf(v));
    };
    document.getElementById("insert-submit-btn").onclick = (e) => submitInsertMatch(courtId, prevMatch, nextMatch, null, e.currentTarget);
    (ins.actions || []).forEach(a => {
        document.getElementById(`insert-action-${a.id}`).onclick = (e) => submitInsertMatch(courtId, prevMatch, nextMatch, a, e.currentTarget);
    });
}

function wireInsertCornerSearch(side) {
    const input = document.getElementById(`insert-corner-search-${side}`);
    input.oninput = () => {
        clearTimeout(insertSearchTimers[side]);
        const q = input.value.trim();
        const resultsEl = document.getElementById(`insert-corner-results-${side}`);
        if (q.length < 2) { resultsEl.innerHTML = ""; return; }
        insertSearchTimers[side] = setTimeout(async () => {
            try {
                const res = await fetch(`/api/athletes/search-admin?q=${encodeURIComponent(q)}&sport=${encodeURIComponent(SPORT)}&limit=8`);
                const data = await res.json();
                renderInsertCornerResults(side, data.athletes || []);
            } catch (err) {
                resultsEl.innerHTML = `<div class="lq-athlete-result-item">Search failed — try again.</div>`;
            }
        }, 250);
    };
}

function renderInsertCornerResults(side, athletes) {
    const el = document.getElementById(`insert-corner-results-${side}`);
    insertSearchResults[side] = athletes;
    if (athletes.length === 0) {
        el.innerHTML = `<div class="lq-athlete-result-item">No matching athletes.</div>`;
        return;
    }
    el.innerHTML = athletes.map((a, i) => `
        <div class="lq-athlete-result-item" data-idx="${i}">
            <strong>${escapeHtml(a.displayName)}</strong><br>
            <span style="color:var(--lq-muted); font-size:.75rem;">${escapeHtml(a.club || "No club")}${a.birthYear != null ? " · " + a.birthYear : ""}</span>
        </div>
    `).join("");
    [...el.querySelectorAll(".lq-athlete-result-item[data-idx]")].forEach(item => {
        item.onclick = () => pickInsertCorner(side, parseInt(item.dataset.idx, 10));
    });
}

function pickInsertCorner(side, idx) {
    const athlete = insertSearchResults[side][idx];
    if (!athlete) return;
    insertPendingCorners[side] = athlete;
    document.getElementById(`insert-corner-current-${side}`).textContent = athlete.displayName;
    document.getElementById(`insert-corner-search-${side}`).value = "";
    document.getElementById(`insert-corner-results-${side}`).innerHTML = "";
}

function cornerFromAthlete(a) {
    return {
        entryId: a.id,
        athleteIds: [a.id],
        name: a.displayName,
        country: a.country || null,
        clubId: a.clubId || null,
        clubName: a.club || null,
    };
}

async function submitInsertMatch(courtId, prevMatch, nextMatch, action, activeBtn) {
    const errEl = document.getElementById("insert-error");
    errEl.classList.add("hidden");
    const ins = LQ.insert;

    if (!insertPendingCorners.blue || (ins.requiresRed && !insertPendingCorners.red)) {
        errEl.textContent = ins.requiresRed ? "Pick an athlete for both corners." : "Pick at least the Blue athlete.";
        errEl.classList.remove("hidden");
        return;
    }

    const categorySelect = document.getElementById("insert-category");
    let categoryCode, categoryLabel;
    if (categorySelect.value === "__custom__") {
        categoryCode = document.getElementById("insert-category-code").value.trim();
        categoryLabel = document.getElementById("insert-category-label").value.trim();
        if (!categoryCode || !categoryLabel) {
            errEl.textContent = "Enter both a category code and label.";
            errEl.classList.remove("hidden");
            return;
        }
    } else {
        categoryCode = categorySelect.value;
        categoryLabel = categorySelect.options[categorySelect.selectedIndex].textContent;
    }

    const displayNumber = computeInsertDisplayNumber(prevMatch, nextMatch);
    if (displayNumber == null) {
        errEl.textContent = "Couldn't determine a match number — this court has no other matches to anchor to yet.";
        errEl.classList.remove("hidden");
        return;
    }
    const queuePosition = computeInsertQueuePosition(prevMatch, nextMatch);
    const hasRed = !!insertPendingCorners.red;
    const format = ins.format ? ins.format(hasRed) : null;

    const newMatch = {
        tournamentId: TOURNAMENT_ID,
        tournamentName: TOURNAMENT_TITLE,
        categoryCode,
        categoryLabel,
        displayNumber,
        roundPhase: document.getElementById("insert-roundPhase").value,
        blue: cornerFromAthlete(insertPendingCorners.blue),
        red: hasRed ? cornerFromAthlete(insertPendingCorners.red) : null,
        status: "ready",
        winnerEntryId: null,
        courtId,
        queuePosition,
        ...ins.read(),
        ...(format ? { format } : {}),
        isRanked: document.getElementById("insert-isRanked").checked,
        source: "tournament_system_manual_insert",
        assignment: "manual",
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    const buttons = [...document.querySelectorAll("#modal-panel .lq-modal-actions .btn")];
    const originalText = activeBtn ? activeBtn.textContent : "";
    buttons.forEach(b => { b.disabled = true; });
    if (activeBtn) activeBtn.textContent = "Creating…";

    try {
        // A ranked solo performance in a cut-off category also joins its
        // bracket (live-queue-bracket-sync.js) — same batch.
        const batch = fsDb.batch();
        await syncCutOffEntryForRanked(null, newMatch, batch);
        batch.set(matchDocRef(`${TOURNAMENT_ID}_${displayNumber}`), newMatch);
        await batch.commit();
        closeModal();
        if (action && action.after) action.after(newMatch);
    } catch (err) {
        console.error("Insert failed", err);
        errEl.textContent = "Failed to create match: " + err.message;
        errEl.classList.remove("hidden");
        buttons.forEach(b => { b.disabled = false; });
        if (activeBtn) activeBtn.textContent = originalText;
    }
}

// A corner with no entryId yet: a cut-off qualifier still to come, a
// winner of an earlier match ("101 Winner"), or a genuine bye.
function participantLabel(corner) {
    if (!corner) return "BYE";
    if (corner.name) return corner.name;
    if (corner.source && corner.source.matchId) {
        const feeder = matchesById.get(corner.source.matchId);
        return feeder ? `${feeder.displayNumber ?? "?"} Winner` : "Winner TBD";
    }
    if (corner.pendingAdvancement) return "Qualifier (to be decided)";
    return "BYE";
}

// "Blue vs Red", or just the performer of a solo match.
function cornersText(m) {
    return formatOf(m).solo
        ? participantLabel(m.blue)
        : `${participantLabel(m.blue)} vs ${participantLabel(m.red)}`;
}

async function initFirebase() {
    try {
        const res = await fetch("/api/firebase-client-config");
        const config = await res.json();
        if (!config.projectId) {
            setConnState("error", "Firebase not configured");
            return;
        }
        firebase.initializeApp(config);
        fsDb = firebase.firestore();
    } catch (e) {
        setConnState("error", "Config load failed");
    }
}

function setConnState(state, text) {
    const el = document.getElementById("conn-indicator");
    el.className = "lq-conn " + state;
    document.getElementById("conn-text").textContent = text;
}

// ── The ONE Firestore query on this entire page ─────────────────────────
// One long-lived listener on every match of the tournament: the first
// snapshot is billed once, every later one only for changed docs
// (docChanges). Filtering on tournamentId alone needs no composite index.
function subscribeAll() {
    if (!fsDb) return;
    if (unsubscribe) unsubscribe();
    setConnState("", "Connecting…");

    const query = fsDb
        .collection("sports").doc(SPORT)
        .collection("disciplines").doc(DISCIPLINE)
        .collection("matches")
        .where("tournamentId", "==", TOURNAMENT_ID)
        .limit(2000); // sanity ceiling, not pagination

    unsubscribe = query.onSnapshot(
        (snapshot) => {
            setConnState("live", "Live");
            snapshot.docChanges().forEach((change) => {
                if (change.type === "removed") {
                    matchesById.delete(change.doc.id);
                } else {
                    matchesById.set(change.doc.id, { id: change.doc.id, ...change.doc.data() });
                }
            });
            renderCourts();
        },
        (err) => {
            console.error(err);
            setConnState("error", "Connection error — check Firestore rules");
        }
    );
}

// ── Grouping / rendering ─────────────────────────────────────────────────
// "completed" is what Firebase Sync writes for a saved result (kyorugi
// on WIN, poomsae on Final Results); a cut-off performance never gets a
// winnerEntryId. A performance that never happened (DNS, withdrawn…) is
// finished too — it must never show as "next up".
function isDone(m) {
    return m.status === "done" || m.status === "completed" || NOT_PERFORMED.has(m.status) || !!m.winnerEntryId;
}

function statusInfo(m) {
    if (!isDone(m)) return m.status === "ready" ? ["lq-status-ready", "Ready"] : ["lq-status-pending", "Pending"];
    if (m.status === "walkover") return ["lq-status-walkover", "Walkover"];
    if (NOT_PERFORMED.has(m.status)) return ["lq-status-walkover", m.status.toUpperCase() === "DNS" ? "DNS" : m.status[0].toUpperCase() + m.status.slice(1)];
    return ["lq-status-done", "Completed"];
}

function groupByCourtSorted() {
    const byCourt = {};
    matchesById.forEach((m) => {
        const cid = m.courtId || "unassigned";
        (byCourt[cid] = byCourt[cid] || []).push(m);
    });
    Object.values(byCourt).forEach((list) => list.sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0)));
    return byCourt;
}

function findNextUpId(matches) {
    for (const m of matches) {
        if (!isDone(m) && m.status === "ready") return m.id;
    }
    return null;
}

function renderCourts() {
    if (!LQ) return;
    const wrap = document.getElementById("courts-row");
    const byCourt = groupByCourtSorted();
    const courtIds = Object.keys(byCourt).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (courtIds.length === 0) {
        wrap.innerHTML = '<div class="lq-loading">No matches scheduled yet — push brackets first.</div>';
        return;
    }

    const conflicts = LQ.conflicts(byCourt) || new Map();

    wrap.innerHTML = "";
    courtIds.forEach((courtId) => {
        const matches = byCourt[courtId];
        const pending = matches.filter(m => !isDone(m) && m.status !== "ready").length;
        const ready = matches.filter(m => !isDone(m) && m.status === "ready").length;
        const done = matches.filter(isDone).length;
        const conflictCount = matches.filter(m => conflicts.has(m.id)).length;
        const nextUpId = findNextUpId(matches);

        const column = document.createElement("div");
        column.className = "lq-court-column";
        column.dataset.courtId = courtId;
        column.ondragover = (e) => { e.preventDefault(); onColumnDragOver(e, column); };
        column.ondragleave = (e) => onColumnDragLeave(e, column);
        column.ondrop = (e) => { e.preventDefault(); onColumnDrop(e, column, courtId, matches); };

        const header = document.createElement("div");
        header.className = "lq-court-column-header";
        header.innerHTML = `
            <span class="lq-court-column-name">${escapeHtml(courtId)}</span>
            <span class="lq-court-column-meta">${matches.length} total · ${pending} pending · ${ready} ready · ${done} done${conflictCount > 0 ? ` · <span style="color:#b91c1c; font-weight:700;">⚠ ${conflictCount} conflict${conflictCount === 1 ? "" : "s"}</span>` : ""}</span>
        `;
        column.appendChild(header);

        const body = document.createElement("div");
        body.className = "lq-court-column-body";
        if (matches.length === 0) {
            body.innerHTML = `<div class="lq-court-column-empty">No matches on this court.</div>`;
            body.appendChild(buildGap(courtId, null, null));
        } else {
            body.appendChild(buildGap(courtId, null, matches[0]));
            matches.forEach((m, i) => {
                body.appendChild(buildRow(m, m.id === nextUpId, conflicts.get(m.id)));
                body.appendChild(buildGap(courtId, m, matches[i + 1] || null));
            });
        }
        column.appendChild(body);
        wrap.appendChild(column);
    });
}

function buildGap(courtId, prevMatch, nextMatch) {
    const gap = document.createElement("div");
    gap.className = "lq-gap";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lq-gap-btn";
    btn.title = "Insert a match here";
    btn.textContent = "+";
    btn.onclick = (e) => { e.stopPropagation(); openInsertModal(courtId, prevMatch, nextMatch); };
    gap.appendChild(btn);
    return gap;
}

function buildRow(m, isNext, conflictReason) {
    const fmt = formatOf(m);
    const row = document.createElement("div");
    row.className = "lq-row" + (isNext ? " next-up" : "");
    row.draggable = true;
    row.dataset.matchId = m.id;
    row.dataset.format = fmt.key;

    row.ondragstart = (e) => {
        dragState = { matchId: m.id, fromCourtId: m.courtId };
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
    };
    row.ondragend = () => { row.classList.remove("dragging"); removeDropIndicator(); };
    row.onclick = () => { if (!row.classList.contains("dragging")) openDetailModal(m.id); };

    const [statusClass, statusLabel] = statusInfo(m);
    const extra = fmt.rowExtraHtml(m, conflictReason);
    const corners = fmt.solo
        ? `<span class="lq-corner-name solo">${escapeHtml(participantLabel(m.blue))}</span>`
        : `<span class="lq-corner-name blue">${escapeHtml(participantLabel(m.blue))}</span>
           <span class="lq-vs">vs</span>
           <span class="lq-corner-name red">${escapeHtml(participantLabel(m.red))}</span>`;
    const buttons = fmt.rowButtons(m).map(b =>
        `<button type="button" class="lq-print-btn" title="${escapeAttr(b.title || "")}" data-kind="${escapeAttr(b.kind)}">${b.label}</button>`).join("");

    row.innerHTML = `
        <span class="lq-drag-handle" title="Drag to reorder, or drop on another court's column">⠿</span>
        <span class="lq-row-number">#${escapeHtml(String(m.displayNumber ?? "—"))}</span>
        <div class="lq-row-main">
            <div class="lq-row-corners">${corners}</div>
            <div class="lq-row-meta">${escapeHtml(resolveCategoryLabel(m.categoryCode))}${m.roundPhase ? " · " + escapeHtml(m.roundPhase) : ""}${m.isRanked === false ? ' · <span class="lq-unranked-flag">Unranked</span>' : ""}</div>
            ${extra ? `<div class="lq-row-badges">${extra}</div>` : ""}
        </div>
        ${isNext ? '<span class="lq-next-badge">NEXT</span>' : ""}
        <span class="lq-status-pill ${statusClass}">${statusLabel}</span>
        ${buttons}
    `;

    row.querySelectorAll(".lq-print-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            fmt.onRowButton(btn.dataset.kind, m, btn);
        });
    });

    return row;
}

// ── Drag and drop: reorder within a court, or drop onto another court ──
let dropIndicatorEl = null;
function ensureDropIndicator() {
    if (!dropIndicatorEl) {
        dropIndicatorEl = document.createElement("div");
        dropIndicatorEl.className = "lq-drop-indicator";
    }
    return dropIndicatorEl;
}
function removeDropIndicator() {
    if (dropIndicatorEl && dropIndicatorEl.parentNode) dropIndicatorEl.parentNode.removeChild(dropIndicatorEl);
}

function computeDropIndex(bodyEl, clientY) {
    const rows = [...bodyEl.querySelectorAll(".lq-row")];
    let dropIndex = rows.length;
    for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) { dropIndex = i; break; }
    }
    return { dropIndex, rows };
}

function onColumnDragOver(event, column) {
    if (!dragState) return;
    const body = column.querySelector(".lq-court-column-body");
    const { dropIndex, rows } = computeDropIndex(body, event.clientY);

    const indicator = ensureDropIndicator();
    if (dropIndex >= rows.length) body.appendChild(indicator);
    else body.insertBefore(indicator, rows[dropIndex]);

    document.querySelectorAll(".lq-court-column.drag-over").forEach((c) => {
        if (c !== column) c.classList.remove("drag-over");
    });
    column.classList.add("drag-over");
}

function onColumnDragLeave(event, column) {
    if (!column.contains(event.relatedTarget)) column.classList.remove("drag-over");
}

// ── Generic modal ─────────────────────────────────────────────────────
function openModal(innerHtml) {
    document.getElementById("modal-panel").innerHTML = innerHtml;
    document.getElementById("modal-overlay").classList.remove("hidden");
}
function closeModal() {
    document.getElementById("modal-overlay").classList.add("hidden");
    document.getElementById("modal-panel").innerHTML = "";
}

function confirmDragDrop(bodyHtml) {
    return new Promise((resolve) => {
        openModal(`
            <div class="lq-modal-header">
                <h3>Confirm move</h3>
                <button class="lq-modal-close" id="drag-confirm-x">&times;</button>
            </div>
            <div class="lq-modal-body">
                <div class="lq-drag-confirm-text">${bodyHtml}</div>
                <div class="lq-modal-actions">
                    <button class="btn btn-primary" id="drag-confirm-yes">Move it</button>
                    <button class="btn btn-ghost" id="drag-confirm-no">Cancel</button>
                </div>
            </div>
        `);
        const finish = (result) => { closeModal(); resolve(result); };
        document.getElementById("drag-confirm-yes").onclick = () => finish(true);
        document.getElementById("drag-confirm-no").onclick = () => finish(false);
        document.getElementById("drag-confirm-x").onclick = () => finish(false);
    });
}

async function onColumnDrop(event, column, courtId, courtMatches) {
    column.classList.remove("drag-over");
    removeDropIndicator();
    if (!dragState) return;

    const body = column.querySelector(".lq-court-column-body");
    const { dropIndex } = computeDropIndex(body, event.clientY);

    // Leave the dragged match out of its own column before picking neighbours.
    const targetList = courtMatches.filter((m) => m.id !== dragState.matchId);
    const prevMatch = targetList[dropIndex - 1] || null;
    const nextMatch = targetList[dropIndex] || null;

    const draggedId = dragState.matchId;
    const dragged = matchesById.get(draggedId);
    dragState = null;
    if (!dragged) return;

    const num = (x) => (x && x.displayNumber != null ? `#${x.displayNumber}` : "?");
    const positionDesc = !prevMatch && !nextMatch
        ? `as the only match on <strong>${escapeHtml(courtId)}</strong>`
        : !prevMatch
            ? `at the very START of <strong>${escapeHtml(courtId)}</strong>, right before ${escapeHtml(num(nextMatch))}`
            : !nextMatch
                ? `at the very END of <strong>${escapeHtml(courtId)}</strong>, right after ${escapeHtml(num(prevMatch))}`
                : `on <strong>${escapeHtml(courtId)}</strong>, between ${escapeHtml(num(prevMatch))} and ${escapeHtml(num(nextMatch))}`;

    const fmt = formatOf(dragged);
    const who = fmt.solo
        ? `<span>${escapeHtml(participantLabel(dragged.blue))}</span>`
        : `<span style="color:var(--lq-blue)">${escapeHtml(participantLabel(dragged.blue))}</span>
           <span style="color:var(--lq-muted)">vs</span>
           <span style="color:var(--lq-red)">${escapeHtml(participantLabel(dragged.red))}</span>`;

    const confirmed = await confirmDragDrop(`
        Move <strong>#${escapeHtml(String(dragged.displayNumber ?? "?"))} · ${escapeHtml(resolveCategoryLabel(dragged.categoryCode))}</strong><br>
        ${who}
        <br><br>
        ${positionDesc}?
    `);
    if (!confirmed) return;

    try {
        const res = await fetch(`/api/matches/${SPORT}/${DISCIPLINE}/${draggedId}/position`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                courtId,
                prevQueuePosition: prevMatch ? prevMatch.queuePosition : null,
                nextQueuePosition: nextMatch ? nextMatch.queuePosition : null,
            }),
        });
        if (!res.ok) throw new Error(`Reposition failed (${res.status})`);
    } catch (err) {
        console.error("Reposition failed", err);
        alert("Failed to move that match — try again.");
    }
}

// ── Match detail / edit modal ────────────────────────────────────────
// Every field of an UNDECIDED match, saved in one write straight to
// Firestore (Firestore rules gate who may write). Corners are replaced
// by searching for an athlete, never typed by hand; a corner still fed
// by an earlier match is read-only. A replaced athlete is also replaced
// in the bracket doc and in every other match of the category (same
// batch — live-queue-bracket-sync.js). A decided match opens its
// format's result view instead (format.openResult).
let pendingCornerReplacement = { blue: null, red: null };
let cornerSearchTimers = { blue: null, red: null };
let cornerSearchResults = { blue: [], red: [] };
let currentDetailMatchId = null;

function openDetailModal(matchId) {
    const m = matchesById.get(matchId);
    if (!m) return;
    const fmt = formatOf(m);

    if (isDone(m) && fmt.openResult) { fmt.openResult(matchId); appendDeleteMatchButton(matchId); return; }

    currentDetailMatchId = matchId;
    pendingCornerReplacement = { blue: null, red: null };
    cornerSearchResults = { blue: [], red: [] };

    const cornerFieldsHtml = (corner, side) => {
        const label = fmt.solo ? "Athlete" : side === "blue" ? "Blue Corner" : "Red Corner";
        if (!(corner && corner.entryId)) {
            return `
                <div class="lq-detail-corner ${side}">
                    <label>${label}</label>
                    <input type="text" value="${escapeAttr(participantLabel(corner))}" disabled title="Resolves automatically once the earlier round finishes — not directly editable here">
                </div>
            `;
        }
        return `
            <div class="lq-detail-corner ${side}">
                <label>${label}</label>
                <div class="lq-corner-current" id="corner-current-${side}">${escapeHtml(participantLabel(corner))}</div>
                <input type="search" id="corner-search-${side}" class="lq-text-input" placeholder="Search to replace this athlete…" autocomplete="off">
                <div id="corner-results-${side}" class="lq-athlete-results"></div>
            </div>
        `;
    };

    const blueEntryId = m.blue?.entryId || "";
    const redEntryId = m.red?.entryId || "";
    const winnerOptionsHtml = `
        <option value="" ${!m.winnerEntryId ? "selected" : ""}>— none —</option>
        ${blueEntryId ? `<option value="${escapeAttr(blueEntryId)}" ${m.winnerEntryId === blueEntryId ? "selected" : ""}>${escapeHtml(participantLabel(m.blue))} (Blue)</option>` : ""}
        ${redEntryId ? `<option value="${escapeAttr(redEntryId)}" ${m.winnerEntryId === redEntryId ? "selected" : ""}>${escapeHtml(participantLabel(m.red))} (Red)</option>` : ""}
    `;

    // Keep an unusual current phase (e.g. "EXH") selectable.
    const currentPhase = m.roundPhase || "";
    const extraPhaseOption = currentPhase && !fmt.roundPhases.includes(currentPhase)
        ? `<option value="${escapeAttr(currentPhase)}" selected>${escapeHtml(currentPhase)} (current)</option>`
        : "";
    const roundPhaseOptionsHtml = extraPhaseOption + fmt.roundPhases.map(p =>
        `<option value="${p}" ${currentPhase === p ? "selected" : ""}>${p}</option>`
    ).join("");

    const statusKnown = fmt.statusOptions.some(([v]) => v === m.status);
    const statusOptionsHtml = (statusKnown ? "" : `<option value="${escapeAttr(m.status || "")}" selected>${escapeHtml(m.status || "—")} (current)</option>`)
        + fmt.statusOptions.map(([v, l]) => `<option value="${v}" ${m.status === v ? "selected" : ""}>${escapeHtml(l)}</option>`).join("");

    const readonlyExtra = fmt.detailReadonlyHtml(m);

    openModal(`
        <div class="lq-modal-header">
            <h3>#${escapeHtml(String(m.displayNumber ?? "—"))} · ${escapeHtml(resolveCategoryLabel(m.categoryCode))}</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <div class="lq-detail-corners">
                ${cornerFieldsHtml(m.blue, "blue")}
                ${fmt.solo ? "" : cornerFieldsHtml(m.red, "red")}
            </div>

            <div class="lq-detail-grid">
                <label class="lq-span-2">Category Code
                    <input type="text" id="edit-categoryCode" value="${escapeAttr(m.categoryCode || "")}">
                </label>
                <label>Court
                    <input type="text" id="edit-courtId" value="${escapeAttr(m.courtId || "")}">
                </label>
                <label>Status
                    <select id="edit-status">${statusOptionsHtml}</select>
                </label>
                <label>Queue Position
                    <input type="number" step="any" id="edit-queuePosition" value="${m.queuePosition ?? ""}">
                </label>
                <label>Display Number
                    <input type="number" step="any" id="edit-displayNumber" value="${m.displayNumber ?? ""}">
                </label>
                <div class="lq-field-hint lq-span-2">
                    Court/position here is a raw override — it won't recompute neighbours the way drag-and-drop
                    does. Prefer dragging the match when just reordering.
                </div>
                <label>Round Phase
                    <select id="edit-roundPhase">${roundPhaseOptionsHtml}</select>
                </label>
                ${fmt.solo ? "<label>&nbsp;</label>" : `<label>Winner
                    <select id="edit-winnerEntryId">${winnerOptionsHtml}</select>
                </label>`}
                ${fmt.detailFieldsHtml(m)}
                <label class="lq-checkbox-label lq-span-2">
                    <input type="checkbox" id="edit-isRanked" ${m.isRanked !== false ? "checked" : ""}>
                    Ranked / official (counts toward standings)
                </label>
            </div>

            <div class="lq-detail-readonly">
                Round ${escapeHtml(String(m.bracketRound ?? m.round ?? "—"))} · Match ${escapeHtml(String(m.bracketMatchNumber ?? m.matchNumber ?? "—"))}
                ${m.tournamentName ? " · " + escapeHtml(m.tournamentName) : ""}
                ${readonlyExtra ? `<div class="lq-row-badges" style="margin-top:.4rem;">${readonlyExtra}</div>` : ""}
            </div>

            <div id="detail-error" class="lq-alert-error hidden"></div>

            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="detail-save-btn">Save Changes</button>
                ${fmt.detailActionsHtml(m)}
                <button class="btn btn-ghost" onclick="closeModal()">Close</button>
                ${fillByeButtonsHtml(matchId)}
                ${deleteMatchButtonHtml(matchId)}
            </div>
        </div>
    `);

    wireCornerSearch("blue", m.blue);
    if (!fmt.solo) wireCornerSearch("red", m.red);
    document.getElementById("detail-save-btn").onclick = () => saveMatchEdits(matchId);
}

function wireCornerSearch(side, originalCorner) {
    const input = document.getElementById(`corner-search-${side}`);
    if (!input) return;
    input.oninput = () => {
        clearTimeout(cornerSearchTimers[side]);
        const q = input.value.trim();
        const resultsEl = document.getElementById(`corner-results-${side}`);
        if (q.length < 2) { resultsEl.innerHTML = ""; return; }
        cornerSearchTimers[side] = setTimeout(async () => {
            try {
                const res = await fetch(`/api/athletes/search-admin?q=${encodeURIComponent(q)}&sport=${encodeURIComponent(SPORT)}&limit=8`);
                const data = await res.json();
                renderCornerResults(side, data.athletes || [], originalCorner);
            } catch (err) {
                resultsEl.innerHTML = `<div class="lq-athlete-result-item">Search failed — try again.</div>`;
            }
        }, 250);
    };
}

function renderCornerResults(side, athletes, originalCorner) {
    const el = document.getElementById(`corner-results-${side}`);
    cornerSearchResults[side] = athletes;
    if (athletes.length === 0) {
        el.innerHTML = `<div class="lq-athlete-result-item">No matching athletes.</div>`;
        return;
    }
    el.innerHTML = athletes.map((a, i) => `
        <div class="lq-athlete-result-item" data-idx="${i}">
            <strong>${escapeHtml(a.displayName)}</strong><br>
            <span style="color:var(--lq-muted); font-size:.75rem;">${escapeHtml(a.club || "No club")}${a.birthYear != null ? " · " + a.birthYear : ""}</span>
        </div>
    `).join("");
    [...el.querySelectorAll(".lq-athlete-result-item[data-idx]")].forEach(item => {
        item.onclick = () => pickCornerReplacement(side, parseInt(item.dataset.idx, 10), originalCorner);
    });
}

function pickCornerReplacement(side, idx, originalCorner) {
    const athlete = cornerSearchResults[side][idx];
    if (!athlete) return;
    pendingCornerReplacement[side] = athlete;

    document.getElementById(`corner-current-${side}`).innerHTML = `
        <span style="text-decoration:line-through; color:var(--lq-muted);">${escapeHtml(participantLabel(originalCorner))}</span>
        → <strong>${escapeHtml(athlete.displayName)}</strong>
        <button type="button" onclick="undoCornerReplacement('${side}', this)" style="border:none; background:none; color:var(--lq-muted); cursor:pointer; font-size:.75rem; text-decoration:underline;">undo</button>
    `;
    document.getElementById(`corner-search-${side}`).value = "";
    document.getElementById(`corner-results-${side}`).innerHTML = "";
}

function undoCornerReplacement(side) {
    pendingCornerReplacement[side] = null;
    const m = matchesById.get(currentDetailMatchId);
    const corner = side === "blue" ? m?.blue : m?.red;
    document.getElementById(`corner-current-${side}`).textContent = participantLabel(corner);
}

async function saveMatchEdits(matchId) {
    const m = matchesById.get(matchId);
    if (!m) return;
    const fmt = formatOf(m);

    const errEl = document.getElementById("detail-error");
    errEl.classList.add("hidden");

    const status = document.getElementById("edit-status").value;
    const winnerSelect = document.getElementById("edit-winnerEntryId");
    let winnerEntryId = winnerSelect ? (winnerSelect.value || null) : null;

    if (!fmt.solo && fmt.winnerStatuses.includes(status) && !winnerEntryId) {
        errEl.textContent = "Completed / walkover matches need a winner selected.";
        errEl.classList.remove("hidden");
        return;
    }
    if (status === "pending" || status === "ready") winnerEntryId = null; // a reset match has no winner

    const textOrEmpty = (id) => document.getElementById(id).value.trim();
    const numOrNull = (id) => {
        const raw = document.getElementById(id).value;
        if (raw === "") return null;
        const n = Number(raw);
        return Number.isNaN(n) ? null : n;
    };

    const updates = {
        categoryCode: textOrEmpty("edit-categoryCode"),
        courtId: textOrEmpty("edit-courtId"),
        roundPhase: textOrEmpty("edit-roundPhase"),
        status,
        isRanked: document.getElementById("edit-isRanked").checked,
        ...fmt.detailUpdates(m),
    };
    if (!fmt.solo) updates.winnerEntryId = winnerEntryId;
    const qp = numOrNull("edit-queuePosition"); if (qp !== null) updates.queuePosition = qp;
    const dn = numOrNull("edit-displayNumber"); if (dn !== null) updates.displayNumber = dn;

    // A corner is only written when a replacement athlete was picked.
    // (merge write: a solo qualifier slot also drops its placeholder flag)
    const replacedNow = {}; // old entryId -> new corner (bracket sync)
    if (pendingCornerReplacement.blue) {
        updates.blue = cornerFromAthlete(pendingCornerReplacement.blue);
        if (fmt.solo && m.blue && m.blue.pendingAdvancement) updates.blue.pendingAdvancement = firebase.firestore.FieldValue.delete();
        if (m.blue && m.blue.entryId) replacedNow[m.blue.entryId] = updates.blue;
    }
    if (pendingCornerReplacement.red) {
        updates.red = cornerFromAthlete(pendingCornerReplacement.red);
        if (m.red && m.red.entryId) replacedNow[m.red.entryId] = updates.red;
    }

    const saveBtn = document.getElementById("detail-save-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    try {
        const batch = fsDb.batch();
        if (!fmt.solo) propagateWinnerChangeIfNeeded(m, winnerEntryId, batch);
        // A replaced athlete is replaced everywhere: the bracket doc's entries
        // and every other match of this category (live-queue-bracket-sync.js).
        const syncNotes = Object.keys(replacedNow).length
            ? await syncBracketForReplacement(m, updates, replacedNow, batch)
            : [];
        // Ranked ticked / unticked on a cut-off performance: join / leave
        // its bracket. (Not together with a corner replacement — that
        // already rewrites the bracket's entries in this batch.)
        if (fmt.solo && !Object.keys(replacedNow).length && (m.isRanked !== false) !== updates.isRanked) {
            const after = { ...m, ...updates };
            await syncCutOffEntryForRanked(m, after, batch);
            if (after.bracketRound != null && m.bracketRound == null) {
                updates.bracketRound = after.bracketRound;
                updates.bracketMatchNumber = after.bracketMatchNumber;
            }
        }
        batch.set(matchDocRef(matchId), updates, { merge: true });
        await batch.commit();
        closeModal();
        if (syncNotes.length) alert("Saved, but check the bracket:\n\n" + syncNotes.join("\n"));
    } catch (err) {
        console.error("Save failed", err);
        errEl.textContent = "Save failed: " + err.message;
        errEl.classList.remove("hidden");
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Changes";
    }
}

// ═══════════════════════════════════════════════════════════════════
// WINNER-CHANGE PROPAGATION (head-to-head brackets). Correcting a winner
// rewrites the next round's corner that this match feeds
// (corner.source.matchId); a later match already decided with the old
// winner is reset and the correction cascades.
// ═══════════════════════════════════════════════════════════════════

function matchDocRef(matchId) {
    return fsDb
        .collection("sports").doc(SPORT)
        .collection("disciplines").doc(DISCIPLINE)
        .collection("matches").doc(matchId);
}

function applyCornerUpdateDownstream(originMatchId, cornerData, batch, visited) {
    matchesById.forEach(m => {
        if (visited.has(m.id)) return;
        ["blue", "red"].forEach(side => {
            const corner = m[side];
            if (!corner || !corner.source || corner.source.matchId !== originMatchId) return;

            const otherCorner = m[side === "blue" ? "red" : "blue"];
            const bothKnown = !!cornerData.entryId && !!(otherCorner && otherCorner.entryId);
            const update = { [side]: cornerData };

            // The other side is a BYE (its match was deleted): whoever arrives
            // here goes straight through on a walkover.
            if (otherCorner && otherCorner.bye) {
                const winnerId = cornerData.entryId || null;
                update.status = winnerId ? "walkover" : "pending";
                update.winnerEntryId = winnerId;
                update.win = null;
                update.win_score = null;
                update.win_type = null;
                visited.add(m.id);
                batch.set(matchDocRef(m.id), update, { merge: true });
                applyCornerUpdateDownstream(m.id, winnerId
                    ? { ...cornerData, source: { matchId: m.id, slot: "winner" } }
                    : { entryId: null, source: { matchId: m.id, slot: "winner" } }, batch, visited);
                return;
            }

            const invalidatesExistingResult = m.winnerEntryId && corner.entryId
                && corner.entryId === m.winnerEntryId && corner.entryId !== cornerData.entryId;

            if (invalidatesExistingResult) {
                update.status = bothKnown ? "ready" : "pending";
                update.winnerEntryId = null;
                update.win = null;
                update.win_score = null;
                update.win_type = null;
            } else if (!m.winnerEntryId) {
                update.status = bothKnown ? "ready" : "pending";
            }

            visited.add(m.id);
            batch.set(matchDocRef(m.id), update, { merge: true });

            if (invalidatesExistingResult) {
                applyCornerUpdateDownstream(m.id, { entryId: null, source: { matchId: m.id, slot: "winner" } }, batch, visited);
            }
        });
    });
}

function propagateWinnerChangeIfNeeded(m, newWinnerEntryId, batch) {
    if ((newWinnerEntryId || null) === (m.winnerEntryId || null)) return;
    const visited = new Set([m.id]);
    if (newWinnerEntryId) {
        const winnerCorner = m.blue && m.blue.entryId === newWinnerEntryId ? m.blue
            : m.red && m.red.entryId === newWinnerEntryId ? m.red
                : null;
        if (!winnerCorner) return;
        applyCornerUpdateDownstream(m.id, { ...winnerCorner, source: { matchId: m.id, slot: "winner" } }, batch, visited);
    } else {
        applyCornerUpdateDownstream(m.id, { entryId: null, source: { matchId: m.id, slot: "winner" } }, batch, visited);
    }
}

// ── Utils ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}
function escapeAttr(str) { return escapeHtml(str).replace(/'/g, "\\'"); }