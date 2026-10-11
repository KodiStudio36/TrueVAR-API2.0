/* ════════════════════════════════════════════════════════════════════
 * bracket-builder-common.js — everything the kyorugi and poomsae bracket
 * builders share: category loading, the generate pipeline, bracket
 * previews, PDFs, club sheets, the hard-lock report, push and clean.
 *
 * Loaded by templates/dashboard/bracket_builder_base.html, AFTER
 * bracket-core.js / bracket-sheets.js and AFTER the page constants
 * (TOURNAMENT_ID, TOURNAMENT_SPORT, TOURNAMENT_DISCIPLINE,
 * TOURNAMENT_TITLE, TOURNAMENT_DATE, TOURNAMENT_LOCATION,
 * TOURNAMENT_COURT_NUM). All of these are plain page globals.
 *
 * CONTRACT — every discipline template must define:
 *   const HAS_REST_GAP_LOCK   // true → rest-gap / bracket-order rows in the lock report
 *   const MATCH_NUMBER_PAD    // 0 → "101"; 3 → "001"
 *   newCourt(index)           // default court object for a new row
 *   renderCourtsList()        // courts pane rows
 *   renderCourtColumns()      // Court Order view
 *   generateEverything()      // wired to the Generate button
 *   disciplineHardLockChecks(report, labelOf)  // extra locks (may be a no-op)
 *   disciplineEquipmentPayload()               // `equipment` object sent on push
 *   disciplineMatchFields(match)               // extra per-match fields sent on push ({} for none)
 *   init()                    // page start-up; call it at the end of the page script
 * ════════════════════════════════════════════════════════════════════ */
"use strict";

// Shared session state. Discipline pages add their own on top.
let courts = [];             // [{id, label, minGapBetweenSameAthlete, ...discipline fields}] — session-only, never written to Firestore directly
let flatCategories = [];     // populated categories only: {code, ageCode, genderCode, entryTypeCode, groupLabel, label, ageMin, ageMax, weightIndex, roundTime, breakTime}
let divisionRosterCache = {};
let generatedBrackets = [];  // [{categoryCode, categoryLabel, entries, rounds, system, ...}]
let generatedMatches = [];   // flat list across every category, mutated in place by drag-and-drop

// Logos, fonts and every printable sheet live in bracket-sheets.js
// (shared with live_queue.html). A logo picked from disk just
// reconfigures that library.
function onLogoSelected(event, side) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        BracketSheets.configure({ logos: { [side]: reader.result } });
        BracketSheets.prepareAssets();
    };
    reader.readAsDataURL(file);
}

// ── Courts ──────────────────────────────────────────────────────────────
// Pre-seeded from the tournament's own courtNum. court.id is written as
// `courtId` on every match and must equal the court-side TrueVAR-Core
// instance's `court_id`, or that court sees no matches at all.
function loadCourtsLocal() {
    courts = [];
    for (let i = 0; i < TOURNAMENT_COURT_NUM; i++) courts.push(newCourt(i));
}

function addCourtRow() {
    courts.push(newCourt(courts.length));
    renderCourtsList();
}

function deleteCourtRow(index) {
    courts.splice(index, 1);
    renderCourtsList();
}

// Loads the category schema for this tournament's sport/discipline and
// keeps only categories that actually have registrations. Category codes
// come from /static/js/category-schema.js — the same rule the category
// manager and the API use (including para classes).
async function loadPopulatedCategories() {
    let dimensions = [];
    try {
        const res = await fetch(`/api/tournaments/${TOURNAMENT_ID}/categories`);
        dimensions = TrueVARCategories.dimensionsFor(await res.json(), TOURNAMENT_SPORT, TOURNAMENT_DISCIPLINE);
    } catch (err) {
        console.error("Failed to load category schema", err);
    }

    const flat = TrueVARCategories.flatten(dimensions);

    let counts = {};
    try {
        const res = await fetch(`/api/tournaments/${TOURNAMENT_ID}/category-counts`);
        const data = await res.json();
        counts = data.categoryCounts || {};
    } catch (err) {
        console.error("Failed to load category counts", err);
    }

    flatCategories = flat.filter(c => (counts[c.code] || 0) > 0);

    // Registrations under a code the schema doesn't produce would silently
    // never get a bracket — say so.
    const known = new Set(flat.map(c => c.code));
    const orphaned = Object.entries(counts).filter(([code, n]) => n > 0 && !known.has(code));
    if (orphaned.length > 0) {
        console.warn("Registrations in categories not in the current schema:", orphaned);
        showFlash(`${orphaned.reduce((s, [, n]) => s + n, 0)} registration(s) are in categories the current schema doesn't contain — they won't get brackets. Check them in Manage Categories.`, true);
    }
}

// ══════════════════════════════════════════════════════════════════
// ORDERING STRATEGIES — rank entries 1..N. Registry: add more here.
// ══════════════════════════════════════════════════════════════════
const ORDERING_STRATEGIES = {
    registration_order: (entries) => entries.slice(),
};

// ══════════════════════════════════════════════════════════════════
// PLACEMENT STRATEGIES + SINGLE ELIMINATION — live in bracket-core.js,
// shared with live_queue.html so a bracket rebuilt from Firestore is
// byte-for-byte the tree that was generated here. Add new placement
// strategies to BracketCore.PLACEMENT_STRATEGIES, not here.
// ══════════════════════════════════════════════════════════════════
const { sameClub, cornerFromEntry, generateSingleElimination, PLACEMENT_STRATEGIES } = BracketCore;

// ══════════════════════════════════════════════════════════════════
// COURT ORDERING (KYORUGI) — HARD LOCKS #1 and #3
//
// Timeline: every court runs positions 0,1,2,... back to back — there
// are NO holds, a court never idles. Position t on court A happens
// roughly together with position t on court B.
//
// Lock #3: each category is assigned to exactly one court up front
// (fight-count balancing, LPT) and its matches are only ever
// scheduled there. Plexi / vestNumbers are soft preferences inside
// that assignment; the vest-gen court lock stays a hard filter.
//
// Lock #1: two matches that CAN contain the same athlete should be at
// least `need` fights apart (need = max minGap of both courts). "Can
// contain" uses the set of every athlete who could reach a match
// (feeder subtree), so it also covers not-yet-known winners and
// athletes entered in several categories on different courts.
// Each court always takes the best match that satisfies the gap; only
// when NO remaining match on that court can satisfy it does the least-
// bad one go next anyway, marked restGapRelaxed.
//
// Age order is SOFT: matches that still have later rounds depending on
// them (critical path) go first, age order breaks ties.
//
// Equipment is soft too: if no vest / helmet is free, the match is
// placed anyway with scheduledWithRelaxedConstraints and the
// revalidator flags the conflict.
// ══════════════════════════════════════════════════════════════════
function courtById(id) { return courts.find(c => c.id === id) || null; }

// ══════════════════════════════════════════════════════════════════════
// GENERATE — shared pipeline. Each discipline page's generateEverything()
// calls these three in order: ensureReadyToGenerate → buildAllBrackets →
// (its own court ordering + numbering) → showGenerationResults.
// ══════════════════════════════════════════════════════════════════════
function ensureReadyToGenerate() {
    if (flatCategories.length === 0) {
        showFlash("No populated categories to generate brackets for.", true);
        return false;
    }
    if (courts.length === 0) {
        showFlash("Add at least one court first.", true);
        return false;
    }
    return true;
}

// Roster entries for one category, from the (cached) division roster.
async function loadEntriesForCategory(cat) {
    if (!(cat.ageCode in divisionRosterCache)) {
        try {
            const res = await fetch(`/api/tournaments/${TOURNAMENT_ID}/division-rosters/${cat.ageCode}`);
            const data = await res.json();
            divisionRosterCache[cat.ageCode] = data.athletes || {};
        } catch (err) {
            console.error("Failed to load roster for", cat.code, err);
            return null;
        }
    }
    const rosterEntries = (divisionRosterCache[cat.ageCode] || {})[cat.code] || {};
    return Object.entries(rosterEntries).map(([entryId, entry]) => {
        const members = entry.members || [];
        return {
            entryId,
            athleteIds: members.map(m => m.athleteId),
            clubId: members[0] ? members[0].clubId : null,
            clubName: members[0] ? members[0].club : null,
            country: members[0] ? members[0].country : null,
            name: members.map(m => m.name).join(" & "),
        };
    });
}

// Builds every category's bracket into generatedBrackets/generatedMatches.
//   categories        — flatCategories in the order to process them
//   systemKey         — "single_elimination" | "cut_off" | "round_robin",
//                       or a function (cat) -> one of those, for a
//                       different system per category
//   build(cat, seeded, systemKey) — returns { rounds, bracketSize, ... }
//   decorateMatch(m, cat)      — stamps discipline fields onto each match
//   extraBracketFields(cat, systemKey) — discipline fields for the bracket record
//   allowSingleEntry  — true (or a function (cat, systemKey) -> bool) for
//                       solo formats: a cut-off needs no opponent
// -> { skippedSingleEntryCount, totalConflicts }
async function buildAllBrackets({ categories, systemKey, build, decorateMatch, extraBracketFields, allowSingleEntry }) {
    const orderingKey = document.getElementById("orderingSelect").value;
    const placementKey = document.getElementById("placementSelect").value;
    const orderingFn = ORDERING_STRATEGIES[orderingKey];

    generatedBrackets = [];
    generatedMatches = [];
    let totalConflicts = 0;
    let skippedSingleEntryCount = 0;

    for (const cat of categories) {
        const entries = await loadEntriesForCategory(cat);
        if (!entries || entries.length === 0) continue;
        const system = typeof systemKey === "function" ? systemKey(cat) : systemKey;
        const soloOk = typeof allowSingleEntry === "function" ? allowSingleEntry(cat, system) : !!allowSingleEntry;
        if (!soloOk && entries.length < 2) { skippedSingleEntryCount++; continue; }

        const seeded = orderingFn(entries);
        seeded.forEach((e, i) => { e.seed = i + 1; });

        const built = build(cat, seeded, system);
        totalConflicts += built.conflictCount || 0;

        built.rounds.forEach(roundMatches => roundMatches.forEach(m => {
            m.roundTime = cat.roundTime;
            m.breakTime = cat.breakTime;
            if (decorateMatch) decorateMatch(m, cat);
        }));

        generatedBrackets.push({
            categoryCode: cat.code, categoryLabel: `${cat.groupLabel} · ${cat.label}`,
            discipline: TOURNAMENT_DISCIPLINE, format: system === "cut_off" ? "solo" : "duel",
            system,
            orderingStrategy: orderingKey,
            placementStrategy: system === "single_elimination" ? placementKey : null,
            entries: seeded.map(e => ({ entryId: e.entryId, athleteIds: e.athleteIds, clubId: e.clubId, clubName: e.clubName, country: e.country, name: e.name, seed: e.seed })),
            rounds: built.rounds,
            bracketSize: built.bracketSize,
            entrySlotIndex: built.entrySlotIndex,
            minClubClashes: built.minClubClashes ?? null,
            minClashProven: built.minClashProven ?? null,
            ageMin: cat.ageMin,
            ...(extraBracketFields ? extraBracketFields(cat, system) : {}),
        });
        built.rounds.forEach(roundMatches => roundMatches.forEach(m => generatedMatches.push(m)));
    }
    return { skippedSingleEntryCount, totalConflicts };
}

// Writes the summary line (plus the hard-lock verdict) and shows results.
function showGenerationResults(summaryParts, lockReport) {
    document.getElementById("generateSummary").innerHTML =
        summaryParts.filter(Boolean).map(p => `${p} · `).join("")
        + `<strong style="color:${lockReport.ok ? "#16a34a" : "#b91c1c"};">${lockReport.ok ? "hard locks OK" : "hard-lock violations — see report"}</strong>`;

    renderBracketsPreview();
    renderCourtColumns();
    document.getElementById("resultsSection").classList.remove("hidden");
    document.getElementById("pushBtn").disabled = false;
    document.getElementById("pushBtn").textContent = "Push to Firebase";
}

// ══════════════════════════════════════════════════════════════════
// HARD-LOCK CHECKER — independent of how the schedule was produced
// (generator, drag, or future code). Push is blocked unless report.ok.
// ══════════════════════════════════════════════════════════════════
function validateHardLocks() {
    const report = { restGap: [], restGapRelaxed: [], firstRound: [], categoryCourt: [], dependency: [], notes: [], ok: true };
    if (generatedBrackets.length === 0) return report;

    const labelOf = {};
    generatedBrackets.forEach(b => { labelOf[b.categoryCode] = b.categoryLabel; });
    const courtLabel = id => (courtById(id) || {}).label || id;

    // LOCK #3 — one court per category, every real match on a court
    generatedBrackets.forEach(b => {
        const real = b.rounds.flat().filter(m => m.status !== "walkover");
        if (real.length === 0) return;
        const ids = [...new Set(real.filter(m => m.courtId).map(m => m.courtId))];
        if (ids.length > 1) report.categoryCourt.push(`${b.categoryLabel}: split across ${ids.map(courtLabel).join(", ")}`);
        const off = real.filter(m => !m.courtId);
        if (off.length > 0) {
            report.categoryCourt.push(`${b.categoryLabel}: ${off.length} match(es) not on any court${off[0].unassignedReason ? ` (${off[0].unassignedReason})` : ""}`);
        }
    });

    // Discipline-specific locks (kyorugi: bracket order + rest gap).
    disciplineHardLockChecks(report, labelOf);

    // LOCK #2 — same-club round-1 pairs vs. the proven minimum
    generatedBrackets.filter(b => b.system === "single_elimination").forEach(b => {
        const clashes = b.rounds[0].filter(m => m.status !== "walkover" && sameClub(m.blue, m.red));
        const min = b.minClubClashes ?? 0;
        if (clashes.length > min) {
            report.firstRound.push(`${b.categoryLabel}: ${clashes.length} same-club first-round pair(s), only ${min} unavoidable — use "Club spread" placement`);
        } else if (clashes.length > 0) {
            report.notes.push(`${b.categoryLabel}: ${clashes.length} same-club first-round pair(s), mathematically unavoidable${b.minClashProven ? "" : " (best found — search limit reached)"}`);
        }
    });

    report.ok = [report.restGap, report.firstRound, report.categoryCourt, report.dependency].every(l => l.length === 0);
    return report;
}

function renderHardLockReport(report) {
    const el = document.getElementById("hardLockReport");
    if (!el) return;
    if (generatedBrackets.length === 0) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");

    const listOf = items => `<ul>${items.slice(0, 6).map(t => `<li>${escapeHtml(t)}</li>`).join("")}${items.length > 6 ? `<li class="text-muted">+${items.length - 6} more</li>` : ""}</ul>`;
    const row = (title, items, applies, relaxed) => {
        if (applies === false) {
            return `<div class="bb-lock-row bb-lock-row--na"><span>–</span><strong>${title}</strong><span class="text-muted">not applicable</span></div>`;
        }
        relaxed = relaxed || [];
        if (items.length > 0) {
            return `<div class="bb-lock-row bb-lock-row--bad">
                <span>⛔</span><strong>${title}</strong><span>${items.length} violation(s)</span>${listOf(items)}
            </div>`;
        }
        if (relaxed.length > 0) {
            return `<div class="bb-lock-row bb-lock-row--warn">
                <span>⚠</span><strong>${title}</strong><span>${relaxed.length} relaxed — no other order possible</span>${listOf(relaxed)}
            </div>`;
        }
        return `<div class="bb-lock-row bb-lock-row--ok"><span>✓</span><strong>${title}</strong><span>OK</span></div>`;
    };
    const anyElim = generatedBrackets.some(b => b.system === "single_elimination");
    const notes = report.notes.length
        ? `<div class="bb-lock-notes">${report.notes.slice(0, 6).map(n => `<div>ℹ ${escapeHtml(n)}</div>`).join("")}${report.notes.length > 6 ? `<div class="text-muted">+${report.notes.length - 6} more</div>` : ""}</div>`
        : "";

    el.innerHTML = `
        <div class="bb-pane-header">
            <h2 class="panel-title" style="font-size:1.05rem;">Hard-lock check</h2>
            <span class="badge ${report.ok ? "badge-green" : ""}" style="${report.ok ? "" : "background:#fee2e2; color:#b91c1c;"}">${report.ok ? (report.restGapRelaxed.length ? "Ready to push (with relaxed rest gaps)" : "All locks hold — ready to push") : "Push blocked"}</span>
        </div>
        ${row("Rest gap — min fights between the same athlete's matches", report.restGap, HAS_REST_GAP_LOCK, report.restGapRelaxed)}
        ${row("First round — no same-club pair when avoidable", report.firstRound, anyElim)}
        ${row("One category → one court", report.categoryCourt, true)}
        ${row("Bracket order — every match after its feeders", report.dependency, HAS_REST_GAP_LOCK)}
        ${notes}
    `;
}

function refreshHardLockReport() {
    const report = validateHardLocks();
    renderHardLockReport(report);
    return report;
}

// Kyorugi numbers are "court*100 + position" (101, 102...); poomsae uses
// one zero-padded sequence (001, 002...). MATCH_NUMBER_PAD comes from the page.
function formatMatchNumber(m) {
    if (m.displayNumber == null) return "—";
    return MATCH_NUMBER_PAD ? String(m.displayNumber).padStart(MATCH_NUMBER_PAD, "0") : String(m.displayNumber);
}

// ══════════════════════════════════════════════════════════════════
// GENERATE — orchestrates the pipeline above
// ══════════════════════════════════════════════════════════════════
function showView(view) {
    const showBrackets = view === "brackets";
    document.getElementById("bracketsView").classList.toggle("hidden", !showBrackets);
    document.getElementById("courtOrderView").classList.toggle("hidden", showBrackets);
    document.getElementById("pinBrackets").classList.toggle("bb-pin--active", showBrackets);
    document.getElementById("pinCourtOrder").classList.toggle("bb-pin--active", !showBrackets);
}

// ── Rendering: bracket preview (round-by-round list) ────────────────
let matchById = {};

function rebuildMatchById() {
    matchById = {};
    generatedMatches.forEach(m => { matchById[m.matchId] = m; });
}

function renderBracketsPreview() {
    const el = document.getElementById("bracketsPreview");
    el.innerHTML = generatedBrackets.map(b => {
        const previewBtn = (b.system === "single_elimination" || b.system === "cut_off")
            ? `<button type="button" class="btn btn-ghost btn-sm" onclick="openBracketPreview('${b.categoryCode}')">Preview</button>`
            : "";
        return `
        <div class="bb-bracket-block">
            <div class="bb-bracket-title-row">
                <div class="bb-bracket-title">${escapeHtml(b.categoryLabel)} <span class="text-muted">(${b.entries.length} entries${b.system === "single_elimination" ? `, ${b.bracketSize}-slot bracket` : ""})</span></div>
                ${previewBtn}
            </div>
            ${b.rounds.map((round, ri) => `
                <div class="bb-round">
                    <div class="bb-round-label">${roundGroupLabel(b, ri)}</div>
                    ${round.map(m => renderMatchLine(m, b)).join("")}
                </div>
            `).join("")}
        </div>
    `;
    }).join("");
}

const CUT_OFF_STAGE_NAMES = { PR: "Preliminary Round", SF: "Semi-Final", F: "Final" };

function roundGroupLabel(bracket, roundIndex) {
    if (bracket.system === "single_elimination") {
        return roundIndex === bracket.rounds.length - 1 ? "Final" : `Round ${roundIndex + 1}`;
    }
    if (bracket.system === "cut_off") {
        const code = bracket.rounds[roundIndex][0] ? bracket.rounds[roundIndex][0].roundPhase : null;
        return CUT_OFF_STAGE_NAMES[code] || `Stage ${roundIndex + 1}`;
    }
    return `Round ${roundIndex + 1}`;
}

// Name plus country code, e.g. "Peter Parker (SVK)".
function entryNameForMatch(entries, entryId) {
    const e = entries.find(x => x.entryId === entryId);
    const name = e ? e.name : entryId;
    const country = e && e.country ? ` (${e.country})` : "";
    return `${name}${country}`;
}

// A participant slot with no entryId yet is a permanent bye ("BYE"),
// fed by an unresolved match ("101 Winner"), or a poomsae cut-off
// placeholder awaiting advancement ("TBD").
function participantLabel(entries, participant) {
    if (!participant) return "";
    if (participant.entryId) return entryNameForMatch(entries, participant.entryId);
    if (participant.pendingAdvancement) return "TBD";
    if (participant.source) {
        const feeder = matchById[participant.source.matchId];
        const num = feeder ? formatMatchNumber(feeder) : "?";
        return `${num} Winner`;
    }
    return "BYE";
}

// A poomsae cut-off match has NO red corner at all (m.red is null).
function renderMatchLine(m, bracket) {
    const n1 = participantLabel(bracket.entries, m.blue);
    const numPrefix = m.displayNumber != null ? `${formatMatchNumber(m)}. ` : "";
    if (!m.red) {
        const badge = m.status === "pending" ? `<span class="badge badge-grey">pending</span>` : "";
        return `<div class="bb-match-line">${numPrefix}${escapeHtml(n1)} <span class="text-muted">— performs solo</span> ${badge}</div>`;
    }
    const n2 = participantLabel(bracket.entries, m.red);
    const clubClash = bracket.system === "single_elimination" && m.round === 1 && m.status !== "walkover" && sameClub(m.blue, m.red)
        ? `<span class="badge" style="background:#fef3c7; color:#b45309;" title="Same club in round 1">same club</span>` : "";
    const badge = m.status === "walkover" ? `<span class="badge badge-grey">walkover</span>` : m.status === "pending" ? `<span class="badge badge-grey">pending</span>` : "";
    return `<div class="bb-match-line">${numPrefix}${escapeHtml(n1)} <span class="text-muted">vs</span> ${escapeHtml(n2)} ${badge} ${clubClash}</div>`;
}

// ══════════════════════════════════════════════════════════════════
// PRINTABLE SHEETS — drawn by bracket-sheets.js (vector SVG preview,
// searchable vector PDF). This page only supplies its own header text
// and match-number formatting (poomsae numbers are zero-padded).
// ══════════════════════════════════════════════════════════════════
function sheetOptions() {
    return {
        title: TOURNAMENT_TITLE,
        date: TOURNAMENT_DATE,
        location: TOURNAMENT_LOCATION,
        formatNumber: m => (m.displayNumber == null ? "" : formatMatchNumber(m)),
    };
}

function safeFileName(str, fallback) {
    return (str || fallback).replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || fallback;
}

function openBracketPreview(categoryCode) {
    const bracket = generatedBrackets.find(b => b.categoryCode === categoryCode);
    if (!bracket) return;

    document.getElementById("bracketPreviewTitle").textContent = bracket.categoryLabel;
    document.getElementById("bracketPreviewBody").innerHTML = BracketSheets.toSVG(bracket, sheetOptions());

    const btn = document.getElementById("bracketPreviewDownload");
    btn.onclick = async () => {
        btn.disabled = true;
        try {
            await BracketSheets.downloadPdf([bracket], `${safeFileName(bracket.categoryCode, "bracket")}.pdf`, sheetOptions());
        } catch (err) {
            console.error("Failed to build bracket PDF", err);
            showFlash(err.message || "Failed to build the PDF — try again.", true);
        } finally {
            btn.disabled = false;
        }
    };

    document.getElementById("bracketPreviewOverlay").classList.remove("hidden");
}

function closeBracketPreview() {
    document.getElementById("bracketPreviewOverlay").classList.add("hidden");
}

// One searchable vector PDF for every printable bracket (text is real
// text — Ctrl+F finds names, clubs, match numbers).
async function downloadAllBracketsPDF() {
    const eligible = generatedBrackets.filter(BracketSheets.isPrintable);
    if (eligible.length === 0) {
        showFlash(
            generatedBrackets.length === 0
                ? "Generate brackets first."
                : "None of the generated brackets have a printable sheet — round-robin categories don't have one.",
            true
        );
        return;
    }

    const btn = document.getElementById("downloadAllPdfBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Building PDF…"; }

    try {
        await BracketSheets.downloadPdf(eligible, `${safeFileName(TOURNAMENT_TITLE, "brackets")}_all_brackets.pdf`, sheetOptions());
        if (eligible.length < generatedBrackets.length) {
            showFlash(`Built ${eligible.length} of ${generatedBrackets.length} — round-robin categories don't have a printable sheet.`);
        }
    } catch (err) {
        console.error("Failed to build brackets PDF", err);
        showFlash(err.message || "Failed to build the PDF — try again.", true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Download All (PDF)"; }
    }
}

// ══════════════════════════════════════════════════════════════════
// CLUB SHEETS — one PDF page per club: every fighter, their category,
// and every fight they could structurally have, one fixed column per
// round phase (R32, R16, QF, SF, F), "B 308" / "R 312" format.
// Elimination-shaped: cut_off / round_robin entries get blank phases.
// ══════════════════════════════════════════════════════════════════
const CLUB_SHEET_MARGIN = 14; // mm

const ROUND_PHASE_COLUMNS = ["R32", "R16", "QF", "SF", "F"];

function computeEntryFightsByPhase(bracket, entryId) {
    const slotIndex = bracket.entrySlotIndex ? bracket.entrySlotIndex[entryId] : undefined;
    const byPhase = {};
    if (slotIndex == null) return byPhase;

    let matchIndex = Math.floor(slotIndex / 2);
    let corner = slotIndex % 2 === 0 ? "blue" : "red";

    for (let r = 0; r < bracket.rounds.length; r++) {
        const match = bracket.rounds[r][matchIndex];
        if (!match) break;

        if (match.status !== "walkover" && match.displayNumber != null && match.roundPhase) {
            const cornerLetter = corner === "blue" ? "B" : "R";
            byPhase[match.roundPhase] = `${cornerLetter} ${match.displayNumber}`;
        }

        corner = matchIndex % 2 === 0 ? "blue" : "red";
        matchIndex = Math.floor(matchIndex / 2);
    }

    return byPhase;
}

function collectClubSheetRows() {
    const byClub = {};
    generatedBrackets.forEach(b => {
        b.entries.forEach(e => {
            const clubKey = e.clubId || "__none__";
            const bucket = byClub[clubKey] || (byClub[clubKey] = { clubName: null, rows: [] });
            if (!bucket.clubName && e.clubName) bucket.clubName = e.clubName;

            const phases = computeEntryFightsByPhase(b, e.entryId);
            bucket.rows.push({ name: e.name, categoryLabel: b.categoryLabel, phases });
        });
    });
    return byClub;
}

async function buildClubSheetsDoc() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
    const font = await BracketSheets.applyPdfFont(doc); // Unicode font so č/ľ/ť print correctly
    const t = str => BracketSheets.pdfText(doc, str);
    let isFirstPage = true;

    const byClub = collectClubSheetRows();
    const clubKeys = Object.keys(byClub).filter(k => k !== "__none__")
        .sort((a, b) => (byClub[a].clubName || "").localeCompare(byClub[b].clubName || ""));
    if (byClub["__none__"]) clubKeys.push("__none__");

    const columnWidths = { id: 8, participant: 60, phase: (182 - 8 - 60) / ROUND_PHASE_COLUMNS.length };
    const PARTICIPANT_COL_INDEX = 1;

    clubKeys.forEach(key => {
        const club = byClub[key];
        if (!isFirstPage) doc.addPage();
        isFirstPage = false;

        doc.setFont(font, "bold");
        doc.setFontSize(14);
        doc.setTextColor(17, 17, 17);
        doc.text(t(TOURNAMENT_TITLE), CLUB_SHEET_MARGIN, 18);
        doc.setFontSize(13);
        doc.text(t(club.clubName || "No Club"), CLUB_SHEET_MARGIN, 26);

        const body = club.rows.map((r, i) => [
            String(i + 1), "",
            ...ROUND_PHASE_COLUMNS.map(phase => r.phases[phase] || ""),
        ]);

        const columnStyles = {
            0: { cellWidth: columnWidths.id, halign: "center" },
            1: { cellWidth: columnWidths.participant, halign: "left" },
        };
        ROUND_PHASE_COLUMNS.forEach((_, i) => {
            columnStyles[i + 2] = { cellWidth: columnWidths.phase, halign: "center" };
        });

        doc.autoTable({
            startY: 32,
            head: [["No.", "Participant", ...ROUND_PHASE_COLUMNS]],
            body,
            columnStyles,
            styles: { font, fontSize: 8, cellPadding: 1.3, lineColor: [17, 17, 17], lineWidth: 0.2, minCellHeight: 10, valign: "middle" },
            headStyles: { fillColor: [255, 255, 255], textColor: [17, 17, 17], fontStyle: "bold", lineWidth: 0.3, halign: "center", valign: "middle" },
            theme: "grid",
            margin: { left: CLUB_SHEET_MARGIN, right: CLUB_SHEET_MARGIN },
            didDrawCell: (hook) => {
                if (hook.section !== "body" || hook.column.index !== PARTICIPANT_COL_INDEX) return;
                const r = club.rows[hook.row.index];
                const { x, y, width, height } = hook.cell;
                const padX = x + 1.8;

                doc.setFont(font, "bold");
                doc.setFontSize(8);
                doc.setTextColor(17, 17, 17);
                doc.text(t(r.name), padX, y + height / 2 - 1.8);

                doc.setFont(font, "normal");
                doc.setFontSize(6.5);
                doc.setTextColor(100, 100, 100);
                doc.text(t(r.categoryLabel), padX, y + height / 2 + 1.6, { maxWidth: width - 3.6 });
                doc.setTextColor(17, 17, 17);
            },
        });
    });

    return doc;
}

async function downloadClubSheetsPDF() {
    if (generatedBrackets.length === 0) {
        showFlash("Generate brackets first.", true);
        return;
    }
    if (!window.jspdf || !window.jspdf.jsPDF) {
        showFlash("PDF library failed to load — check your connection and retry.", true);
        return;
    }

    const btn = document.getElementById("downloadClubSheetsBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Building…"; }

    try {
        const doc = await buildClubSheetsDoc();
        const safeTitle = (TOURNAMENT_TITLE || "tournament").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
        doc.save(`${safeTitle || "tournament"}_club_sheets.pdf`);
    } catch (err) {
        console.error("Failed to build club sheets PDF", err);
        showFlash("Failed to build the PDF — try again.", true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Download Club Sheets (PDF)"; }
    }
}

// ── Push to Firebase ─────────────────────────────────────────────
async function pushToFirebase() {
    if (generatedBrackets.length === 0) return;

    const lockReport = refreshHardLockReport();
    if (!lockReport.ok) {
        showFlash("Push blocked — fix the hard-lock violations listed in the report first.", true);
        document.getElementById("hardLockReport").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
    }

    // Walkover (BYE) matches never get a court and are never referenced
    // as a `source`; the bracket doc keeps the full record of them.
    const rankedMatches = generatedMatches.filter(m => m.status !== "walkover");

    const relaxedNote = lockReport.restGapRelaxed.length
        ? `\n\n${lockReport.restGapRelaxed.length} match pair(s) run with a relaxed rest gap (no other order was possible).`
        : "";
    if (!confirm(`Push ${generatedBrackets.length} bracket(s) and ${rankedMatches.length} match(es) to Firestore? This is the live commit.${relaxedNote}`)) return;

    const btn = document.getElementById("pushBtn");
    btn.disabled = true;
    btn.textContent = "Pushing…";

    const payload = {
        sport: TOURNAMENT_SPORT,
        discipline: TOURNAMENT_DISCIPLINE,
        brackets: generatedBrackets.map(b => ({
            categoryCode: b.categoryCode, categoryLabel: b.categoryLabel, discipline: b.discipline, format: b.format,
            system: b.system, orderingStrategy: b.orderingStrategy, placementStrategy: b.placementStrategy,
            pssHitLevelSetId: b.pssHitLevelSetId, entries: b.entries,
        })),
        matches: rankedMatches.map(m => ({
            matchId: m.matchId, bracketCategoryCode: m.categoryCode, round: m.round, matchNumber: m.matchNumber,
            displayNumber: m.displayNumber, roundPhase: m.roundPhase,
            blue: m.blue, red: m.red || null, status: m.status, winnerEntryId: m.winnerEntryId,
            courtId: m.courtId, queuePosition: m.queuePosition,
            // Discipline-only fields (kyorugi: vests, helmets, round
            // timing). Fields left out here are not written to the match doc.
            ...disciplineMatchFields(m),
        })),
        // Discipline-specific session config, written to
        // tournaments/{id}/meta/equipment in the same commit.
        equipment: disciplineEquipmentPayload(),
    };

    try {
        const res = await fetch(`/api/tournaments/${TOURNAMENT_ID}/brackets/commit`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(extractErrorDetail(body, `Push failed (${res.status})`));
        }
        showFlash("Brackets pushed to Firestore.");
        btn.textContent = "Pushed ✓";
    } catch (err) {
        console.error("Push failed", err);
        showFlash(err.message || "Push failed — try again.", true);
        btn.disabled = false;
        btn.textContent = "Push to Firebase";
    }
}

// ── Clean / wipe everything this page has pushed for this tournament.
// Gated behind a type-the-title confirmation.
async function cleanPushedData() {
    const typed = prompt(
        `This PERMANENTLY deletes every bracket, match, and equipment setting pushed to Firestore for ` +
        `"${TOURNAMENT_TITLE}". Registrations are NOT affected — only generated bracket/court output.\n\n` +
        `Type the tournament title exactly to confirm:`
    );
    if (typed === null) return;
    if (typed.trim() !== TOURNAMENT_TITLE.trim()) {
        showFlash("Title didn't match — nothing was deleted.", true);
        return;
    }

    const btn = document.getElementById("cleanBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Cleaning…"; }

    try {
        const res = await fetch(
            `/api/tournaments/${TOURNAMENT_ID}/brackets?sport=${encodeURIComponent(TOURNAMENT_SPORT)}&discipline=${encodeURIComponent(TOURNAMENT_DISCIPLINE)}`,
            { method: "DELETE" }
        );
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(extractErrorDetail(body, `Clean failed (${res.status})`));
        }
        const data = await res.json();
        showFlash(`Cleared ${data.deletedBrackets} bracket(s) and ${data.deletedMatches} match(es).`);

        generatedBrackets = [];
        generatedMatches = [];
        renderHardLockReport(validateHardLocks());
        document.getElementById("resultsSection").classList.add("hidden");
        document.getElementById("pushBtn").disabled = true;
        document.getElementById("pushBtn").textContent = "Push to Firebase";
    } catch (err) {
        console.error("Clean failed", err);
        showFlash(err.message || "Clean failed — try again.", true);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = "🗑 Clean Pushed Data"; }
    }
}

// FastAPI error bodies: plain string detail, or a 422 array of {loc, msg, type}.
function extractErrorDetail(body, fallback) {
    const detail = body && body.detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail) && detail.length > 0) {
        return detail.map(d => {
            const loc = Array.isArray(d.loc) ? d.loc.join(".") : "";
            return loc ? `${loc}: ${d.msg}` : (d.msg || JSON.stringify(d));
        }).join("; ");
    }
    return fallback;
}

function showFlash(text, isError) {
    const el = document.getElementById("flash");
    el.textContent = text;
    el.className = `flash-banner ${isError ? "flash-banner--error" : ""}`;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 3000);
}

function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function escapeAttr(str) { return escapeHtml(str); }