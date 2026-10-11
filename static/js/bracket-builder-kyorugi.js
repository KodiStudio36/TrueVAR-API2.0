/* bracket-builder-kyorugi.js — loaded by templates/dashboard/bracket_builder_kyorugi.html,
 * after bracket-builder-common.js (see the contract at the top of that file). */
"use strict";

// ════════════════════════════════════════════════════════════════════
// KYORUGI bracket builder — PSS vests, plexi helmets, equipment
// scheduling, rest-gap hard lock, per-match drag-and-drop. Everything
// shared with poomsae lives in /static/js/bracket-builder-common.js.
// ════════════════════════════════════════════════════════════════════

// ── Equipment state: session-local, same lifecycle as `courts` — never
// written to Firestore, resets if you leave the page. ────────────────
let vestInventory = {};        // key "{pssSize}-{gen}" -> count, e.g. "3-gen3": 6, "3-gen2": 4

let vestGenPolicy = {};        // ageCode -> "either" | "gen2" | "gen3"

let plexiHelmetCount = 2;      // total physical plexi helmets available

let transferBufferSeconds = 300; // time required before a vest/helmet can be reused elsewhere (walk-over + fit time)

let assumedRoundsPerMatch = 3; // used only to estimate match duration for equipment interval checks — see estimateMatchDurationSeconds

let courtBalanceThreshold = 5; // plexi court tolerance: how many extra fights a plexi court may carry before a plexi category is sent to a non-plexi court (see assignCategoriesToCourts)

// ── Hard-lock state ──────────────────────────────────────────────────
let categoryCourtPins = {};    // categoryCode -> courtId, set by dragging a match to another court (moves the whole category). Session-only.

let lastOrderingResult = null; // last generateCourtOrdering result (court loads)

let pssHitLevelSets = [];    // [{id, provider, year, label, note, pssHitLevels}] — every set available for this discipline

let selectedPssHitLevelSetId = null;

// ── Shared-builder contract (see bracket-builder-common.js) ─────────
const HAS_REST_GAP_LOCK = true;
const MATCH_NUMBER_PAD = 0;

function newCourt(i) {
    return { id: String(i + 1), label: `Court ${i + 1}`, vestNumbers: [], minGapBetweenSameAthlete: 3, ageOrder: "oldest_first", plexiCapable: false, allowedVestGen: "any" };
}

async function init() {
    loadCourtsLocal();  // no fetch — courts never touch Firestore
    await Promise.all([
        loadPssHitLevelSets(),
        loadPopulatedCategories(),
        BracketSheets.prepareAssets(), // logos + PDF font, so previews render synchronously
    ]);
    renderCourtsList();
    renderPssHitLevelSetSelect();
    renderVestList();
    renderVestInventory();
    renderVestGenPolicyList();
}

// LOCK #1 (rest gap) + bracket order — kyorugi only. A short pair is
// accepted only if the scheduler marked it relaxed (no other order
// possible); anything else blocks push.
function disciplineHardLockChecks(report, labelOf) {
    const scheduled = generatedMatches.filter(m => m.status !== "walkover" && m.courtId && m.queuePosition != null);

    // Structure — feeder before dependent, same court
    scheduled.forEach(m => {
        feederMatchesOf(m, matchById).forEach(f => {
            if (!f.courtId) return;
            if (f.courtId !== m.courtId || f.queuePosition >= m.queuePosition) {
                report.dependency.push(`${formatMatchNumber(m)} (${labelOf[m.categoryCode]}) runs before its feeder ${formatMatchNumber(f)}`);
            }
        });
    });

    // LOCK #1 — a short pair is accepted only if the scheduler marked
    // it relaxed (no other order possible); anything else blocks push.
    findRestGapPairs().forEach(p => {
        const [first, later] = p.a.queuePosition <= p.b.queuePosition ? [p.a, p.b] : [p.b, p.a];
        const msg = `${formatMatchNumber(first)} → ${formatMatchNumber(later)}: ${Math.max(0, p.between)} fight(s) between, needs ${p.need}`;
        (later.restGapRelaxed ? report.restGapRelaxed : report.restGap).push(msg);
    });
}

// Kyorugi-only match fields (vests, plexi helmets, round timing,
// scheduling flags). Poomsae sends none of these.
function disciplineMatchFields(m) {
    return {
        pssSize: m.pssSize, hitLevel: m.hitLevel, pssHitLevelSetId: m.pssHitLevelSetId,
        roundTime: m.roundTime, breakTime: m.breakTime,
        resolvedVestGen: m.resolvedVestGen || null,
        requiresPlexiHelmet: !!m.requiresPlexiHelmet,
        scheduledWithRelaxedConstraints: !!m.scheduledWithRelaxedConstraints,
        restGapRelaxed: !!m.restGapRelaxed,
    };
}

// Full session-local equipment configuration, written to
// tournaments/{id}/meta/equipment in the same commit.
function disciplineEquipmentPayload() {
    return {
        courts: courts.map(c => ({
            id: c.id, label: c.label, vestNumbers: c.vestNumbers,
            minGapBetweenSameAthlete: c.minGapBetweenSameAthlete, ageOrder: c.ageOrder,
            plexiCapable: c.plexiCapable, allowedVestGen: c.allowedVestGen,
        })),
        vestInventory,
        vestGenPolicy,
        plexiHelmetCount,
        transferBufferSeconds,
        assumedRoundsPerMatch,
        courtBalanceThreshold,
        pssHitLevelSetId: selectedPssHitLevelSetId,
    };
}

function renderCourtsList() {
    const el = document.getElementById("courtsList");
    if (courts.length === 0) {
        el.innerHTML = `<p class="text-muted" style="padding: 0.5rem 0;">No courts yet — add one below.</p>`;
        return;
    }


    el.innerHTML = courts.map((c, i) => `
        <div class="bb-court-row">
            <input type="text" value="${escapeAttr(c.id)}" placeholder="Court ID" title="Must exactly match this court's TrueVAR-Core instance's own court_id"
                style="font-weight: 600;" onchange="courts[${i}].id = this.value.trim()">
            <input type="text" value="${escapeAttr(c.label)}" placeholder="Label" onchange="courts[${i}].label = this.value">
            <input type="text" value="${(c.vestNumbers || []).join(', ')}" placeholder="Vest #s, e.g. 1, 2, 3, 4"
                onchange="courts[${i}].vestNumbers = this.value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))">
            <input type="number" min="0" value="${c.minGapBetweenSameAthlete}" title="HARD LOCK — minimum fights between two matches of the same athlete"
                onchange="courts[${i}].minGapBetweenSameAthlete = parseInt(this.value) || 0">
            <select onchange="courts[${i}].ageOrder = this.value">
                <option value="oldest_first" ${c.ageOrder === "oldest_first" ? "selected" : ""}>Oldest first</option>
                <option value="youngest_first" ${c.ageOrder === "youngest_first" ? "selected" : ""}>Youngest first</option>
            </select>
            <label class="bb-plexi-check" title="Soft preference — plexi-requiring categories are assigned to this court unless it would get more than the plexi tolerance ahead of a non-plexi court. Actual helmet availability is checked separately via the helmet count.">
                <input type="checkbox" ${c.plexiCapable ? "checked" : ""} onchange="courts[${i}].plexiCapable = this.checked">
                Plexi
            </label>
            <select title="Hard lock — this court can ONLY use the selected vest generation, regardless of inventory elsewhere" onchange="courts[${i}].allowedVestGen = this.value">
                <option value="any" ${c.allowedVestGen === "any" || !c.allowedVestGen ? "selected" : ""}>Any gen</option>
                <option value="gen2" ${c.allowedVestGen === "gen2" ? "selected" : ""}>Gen2 only</option>
                <option value="gen3" ${c.allowedVestGen === "gen3" ? "selected" : ""}>Gen3 only</option>
            </select>
            <button type="button" class="cm-bin-btn-inline" onclick="deleteCourtRow(${i})" title="Remove court">✕</button>
        </div>
    `).join("");
}

// ── PSS size / hit-level: multiple named reference sets, admin picks ──
// one at generation time (different providers, or the same provider's
// chart revised in a later year).
async function loadPssHitLevelSets() {
    try {
        const res = await fetch(`/api/sports/${TOURNAMENT_SPORT}/disciplines/${TOURNAMENT_DISCIPLINE}/pss-hit-level-sets`);
        const data = await res.json();
        pssHitLevelSets = data.sets || [];
        selectedPssHitLevelSetId = pssHitLevelSets.length > 0 ? pssHitLevelSets[0].id : null;
    } catch (err) {
        console.error("Failed to load PSS hit-level sets", err);
        pssHitLevelSets = [];
        selectedPssHitLevelSetId = null;
    }
}

function renderPssHitLevelSetSelect() {
    const el = document.getElementById("pssSetSelect");
    if (pssHitLevelSets.length === 0) {
        el.innerHTML = `<option value="">No PSS hit-level tables uploaded</option>`;
        el.disabled = true;
        return;
    }
    el.disabled = false;
    el.innerHTML = pssHitLevelSets.map(s =>
        `<option value="${escapeAttr(s.id)}">${escapeHtml(s.label || s.id)}${s.provider ? ` (${escapeHtml(s.provider)}${s.year ? " " + s.year : ""})` : ""}</option>`
    ).join("");
    el.value = selectedPssHitLevelSetId;
}

function onPssSetChange() {
    selectedPssHitLevelSetId = document.getElementById("pssSetSelect").value || null;
    renderVestList();
    renderVestInventory();
}

function currentPssHitLevels() {
    const set = pssHitLevelSets.find(s => s.id === selectedPssHitLevelSetId);
    return set ? (set.pssHitLevels || {}) : {};
}

// requiresPlexiHelmet lives on the SELECTED PSS SET document itself
// (keyed by age division code), not on the tournament's category
// schema. Looked up lazily since loadPssHitLevelSets and
// loadPopulatedCategories run concurrently in init().
function currentRequiresPlexiHelmetMap() {
    const set = pssHitLevelSets.find(s => s.id === selectedPssHitLevelSetId);
    return set ? (set.requiresPlexiHelmet || {}) : {};
}

function categoryRequiresPlexiHelmet(cat) {
    if (!cat) return false;
    return !!currentRequiresPlexiHelmetMap()[cat.ageCode];
}

// Tournament-local policy for which vest generation an age division
// should be told to use — "either" lets the scheduler pick whichever
// pool has room at assignment time (see checkVestAvailability).
function resolveVestGenPolicy(ageCode) {
    return vestGenPolicy[ageCode] || "either";
}

// Looks up pssSize/hitLevel for one leaf category by its weightIndex
// — the chosen set's array is index-parallel with the weight list.
function vestInfoFor(cat) {
    const rows = currentPssHitLevels()[`${cat.ageCode}|${cat.genderCode}`];
    if (!rows || cat.weightIndex == null) return null;
    const row = rows[cat.weightIndex];
    if (!row) return null;
    return { ...row, vestGenPolicy: resolveVestGenPolicy(cat.ageCode) };
}

// Read-only — PSS size/hit-level are derived automatically.
function renderVestList() {
    const el = document.getElementById("vestList");
    if (flatCategories.length === 0) {
        el.innerHTML = `<p class="text-muted" style="padding: 0.5rem 0;">No populated categories yet — register some athletes first.</p>`;
        return;
    }
    // An older PSS set without a requiresPlexiHelmet map silently
    // resolves every category to "doesn't need plexi" — surface that.
    const plexiMapMissing = Object.keys(currentRequiresPlexiHelmetMap()).length === 0;
    const warning = plexiMapMissing
        ? `<p style="color:#b91c1c; font-size:0.82rem; padding:0.4rem 0; border-bottom:1px solid #fecaca; margin-bottom:0.5rem;">
             ⚠ The selected PSS set has no plexi-helmet data. Every category below will be treated as
             NOT needing a plexi helmet, even if some really do — re-upload the PSS set with a
             <code>requiresPlexiHelmet</code> map to fix court routing.
           </p>`
        : "";
    el.innerHTML = warning + flatCategories.map(c => {
        const info = vestInfoFor(c);
        const plexi = categoryRequiresPlexiHelmet(c) ? ` · <span title="Requires plexi helmet">🪖 plexi</span>` : "";
        const display = info
            ? `PSS ${info.pssSize} · hit-level ${info.hitLevel} · gen: ${info.vestGenPolicy}${plexi}`
            : `<span class="text-muted">no data</span>${plexi}`;
        return `
            <div class="bb-vest-row">
                <span>${escapeHtml(c.groupLabel)} · ${escapeHtml(c.label)}</span>
                <span>${display}</span>
            </div>
        `;
    }).join("");
}

// ══════════════════════════════════════════════════════════════════
// EQUIPMENT: vest inventory (by size+gen), vest gen policy, plexi
// helmets. Session-local. KYORUGI ONLY.
// ══════════════════════════════════════════════════════════════════
function allPssSizesInCurrentSet() {
    const sizes = new Set();
    Object.values(currentPssHitLevels()).forEach(rows => rows.forEach(r => sizes.add(r.pssSize)));
    return [...sizes].sort((a, b) => a - b);
}

function vestKey(pssSize, gen) { return `${pssSize}-${gen}`; }

function renderVestInventory() {
    const el = document.getElementById("vestInventoryList");
    const sizes = allPssSizesInCurrentSet();
    if (sizes.length === 0) {
        el.innerHTML = `<p class="text-muted" style="padding:0.4rem 0;">Select a PSS table above first.</p>`;
        return;
    }
    el.innerHTML = sizes.map(size => `
        <div class="bb-equip-row">
            <span style="font-weight:600; width:60px;">PSS ${size}</span>
            <label class="bb-field" style="flex:1;">
                <span>gen2 count</span>
                <input type="number" min="0" value="${vestInventory[vestKey(size, 'gen2')] || 0}"
                    onchange="vestInventory['${vestKey(size, 'gen2')}'] = parseInt(this.value) || 0">
            </label>
            <label class="bb-field" style="flex:1;">
                <span>gen3 count</span>
                <input type="number" min="0" value="${vestInventory[vestKey(size, 'gen3')] || 0}"
                    onchange="vestInventory['${vestKey(size, 'gen3')}'] = parseInt(this.value) || 0">
            </label>
        </div>
    `).join("");
}

function renderVestGenPolicyList() {
    const el = document.getElementById("vestGenPolicyList");
    const ageCodes = [...new Set(flatCategories.map(c => c.ageCode))];
    if (ageCodes.length === 0) {
        el.innerHTML = `<p class="text-muted" style="padding:0.4rem 0;">No populated categories yet.</p>`;
        return;
    }
    el.innerHTML = ageCodes.map(ageCode => {
        const label = (flatCategories.find(c => c.ageCode === ageCode) || {}).groupLabel || ageCode;
        const current = vestGenPolicy[ageCode] || "either";
        return `
            <div class="bb-vest-row">
                <span>${escapeHtml(label)} <span class="text-muted">(${escapeHtml(ageCode)})</span></span>
                <select onchange="vestGenPolicy['${ageCode}'] = this.value; renderVestList();">
                    <option value="either" ${current === "either" ? "selected" : ""}>Either</option>
                    <option value="gen2" ${current === "gen2" ? "selected" : ""}>Gen2 only</option>
                    <option value="gen3" ${current === "gen3" ? "selected" : ""}>Gen3 only</option>
                </select>
            </div>
        `;
    }).join("");
}

// mm:ss -> seconds. Falls back to 2min on anything unparsable.
function parseMinSec(str) {
    const m = /^(\d+):(\d{2})$/.exec(str || "");
    return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 120;
}

// Rough duration for EQUIPMENT interval purposes only. Deliberately
// overestimates a little: better to hold a vest slightly too long
// than to double-book it.
function estimateMatchDurationSeconds(cat) {
    if (!cat) return 180;
    const round = parseMinSec(cat.roundTime);
    const brk = parseMinSec(cat.breakTime);
    return round * assumedRoundsPerMatch + brk * (assumedRoundsPerMatch - 1) + 60; // +60s callout/prep buffer
}

// Count-based interval tracker: how many UNITS of a resource key are
// in simultaneous use, not which physical vest.
function makeEquipmentTracker() {
    return { intervals: {}, plexiIntervals: [] };
}

// excludeCourtId: a court reusing its OWN previously-used vest never
// needs to wait out the transfer buffer — the buffer only matters
// when a DIFFERENT court wants the same size/gen.
function overlapCount(list, start, end, excludeCourtId) {
    return list.filter(iv => start < iv.end && end > iv.start && iv.courtId !== excludeCourtId).length;
}

// Returns { ok, resolvedGen, reason }. Tries gen3 first when policy is
// "either", then gen2. Two units needed (both corners wear one).
// allowedGens is the COURT's own hard vest-gen lock, intersected with
// the category's genPolicy.
function checkVestAvailability(tracker, pssSize, genPolicy, allowedGens, start, end, courtId) {
    const policyCandidates = genPolicy === "either" ? ["gen3", "gen2"] : [genPolicy];
    const candidates = policyCandidates.filter(g => allowedGens.includes(g));
    if (candidates.length === 0) {
        return { ok: false, reason: `this court is locked to a vest generation this category can't use` };
    }
    for (const gen of candidates) {
        const key = vestKey(pssSize, gen);
        const capacity = vestInventory[key] || 0;
        if (capacity < 2) continue;
        const used = overlapCount(tracker.intervals[key] || [], start, end, courtId);
        if (capacity - used >= 2) return { ok: true, resolvedGen: gen };
    }
    return { ok: false, reason: `no gen${candidates.length > 1 ? "2/3" : candidates[0].replace("gen", "")} size-${pssSize} VESTS free` };
}

// A court whose allowedVestGen is "any" supports every genPolicy.
// Otherwise the court's single locked gen must be usable by the category.
function courtSupportsGenPolicy(court, genPolicy) {
    if (!court.allowedVestGen || court.allowedVestGen === "any") return true;
    if (genPolicy === "either") return true;
    return court.allowedVestGen === genPolicy;
}

function checkPlexiAvailability(tracker, start, end, courtId) {
    const used = overlapCount(tracker.plexiIntervals, start, end, courtId);
    return (plexiHelmetCount - used >= 2)
        ? { ok: true }
        : { ok: false, reason: "no plexi HELMETS free" };
}

function reserveVest(tracker, pssSize, gen, start, end, courtId) {
    const key = vestKey(pssSize, gen);
    (tracker.intervals[key] = tracker.intervals[key] || []).push({ start, end, courtId });
}

function reservePlexi(tracker, start, end, courtId) {
    tracker.plexiIntervals.push({ start, end, courtId });
}

// Same estimate as estimateMatchDurationSeconds, read off a match's
// own stamped roundTime/breakTime.
function estimateMatchDurationSecondsFromMatch(m) {
    const round = parseMinSec(m.roundTime);
    const brk = parseMinSec(m.breakTime);
    return round * assumedRoundsPerMatch + brk * (assumedRoundsPerMatch - 1) + 60;
}

// Re-checks vest/plexi availability against the CURRENT court +
// queuePosition layout — after generation and after every drag.
// Purely diagnostic: flags m.equipmentConflict, never moves anything.
// Simulates all courts in parallel, always advancing whichever court's
// clock is earliest.
// KYORUGI ONLY.
function revalidateEquipmentAfterManualEdit() {
    const tracker = makeEquipmentTracker();
    const courtClockSeconds = {};
    const queues = {};
    const pointer = {};
    courts.forEach(c => {
        courtClockSeconds[c.id] = 0;
        pointer[c.id] = 0;
        queues[c.id] = generatedMatches
            .filter(m => m.status !== "walkover" && m.courtId === c.id && m.queuePosition != null)
            .sort((a, b) => a.queuePosition - b.queuePosition);
    });

    generatedMatches.forEach(m => { delete m.equipmentConflict; });

    let remaining = Object.values(queues).reduce((n, q) => n + q.length, 0);
    while (remaining > 0) {
        let bestCourt = null;
        courts.forEach(c => {
            if (pointer[c.id] >= queues[c.id].length) return;
            if (bestCourt === null || courtClockSeconds[c.id] < courtClockSeconds[bestCourt.id]) bestCourt = c;
        });
        if (!bestCourt) break;

        const m = queues[bestCourt.id][pointer[bestCourt.id]];
        pointer[bestCourt.id]++;
        remaining--;

        const duration = estimateMatchDurationSecondsFromMatch(m);
        const start = courtClockSeconds[bestCourt.id];
        const end = start + duration + transferBufferSeconds;

        let conflict = null;
        if (m.requiresPlexiHelmet) {
            const plexiCheck = checkPlexiAvailability(tracker, start, end, bestCourt.id);
            if (!plexiCheck.ok) conflict = plexiCheck.reason;
            else reservePlexi(tracker, start, end, bestCourt.id);
        }
        if (m.pssSize != null) {
            // Re-check the SAME generation that was already resolved
            // (falling back to "either" if none).
            const allowedGens = (!bestCourt.allowedVestGen || bestCourt.allowedVestGen === "any") ? ["gen2", "gen3"] : [bestCourt.allowedVestGen];
            const vestCheck = checkVestAvailability(tracker, m.pssSize, m.resolvedVestGen || "either", allowedGens, start, end, bestCourt.id);
            if (!vestCheck.ok) {
                conflict = conflict ? `${conflict}; ${vestCheck.reason}` : vestCheck.reason;
            } else {
                reserveVest(tracker, m.pssSize, vestCheck.resolvedGen, start, end, bestCourt.id);
                m.resolvedVestGen = vestCheck.resolvedGen;
            }
        }
        if (conflict) m.equipmentConflict = conflict;

        courtClockSeconds[bestCourt.id] = end - transferBufferSeconds;
    }
}

function courtGap(courtId) {
    const c = courtById(courtId);
    return c ? Math.max(0, parseInt(c.minGapBetweenSameAthlete) || 0) : 0;
}

function feederMatchesOf(m, lookup) {
    return [m.blue, m.red]
        .filter(p => p && p.source && p.source.matchId)
        .map(p => lookup[p.source.matchId])
        .filter(f => f && f.status !== "walkover");
}

// m._possibleAthletes: every athleteId that could appear in m. Internal
// only — pushToFirebase maps explicit fields, so it is never sent.
function computePossibleAthletes(brackets) {
    const lookup = {};
    brackets.forEach(b => b.rounds.forEach(r => r.forEach(m => { lookup[m.matchId] = m; })));
    brackets.forEach(b => b.rounds.forEach(round => round.forEach(m => {
        const set = new Set();
        [m.blue, m.red].forEach(p => {
            if (!p) return;
            if (p.athleteIds && p.athleteIds.length > 0) p.athleteIds.forEach(id => set.add(id));
            else if (p.source && lookup[p.source.matchId] && lookup[p.source.matchId]._possibleAthletes) {
                lookup[p.source.matchId]._possibleAthletes.forEach(id => set.add(id));
            }
        });
        m._possibleAthletes = set;
    })));
}

// Returns the WORST (smallest between-minus-needed) violation of the
// rest gap for placing `match` at `slot`, or null if none.
function restGapViolation(match, courtId, slot, appearancesByAthlete) {
    const ids = match._possibleAthletes;
    if (!ids || ids.size === 0) return null;
    const ownGap = courtGap(courtId);
    let worst = null;
    for (const id of ids) {
        const list = appearancesByAthlete[id];
        if (!list) continue;
        for (const a of list) {
            if (a.matchId === match.matchId) continue;
            const need = Math.max(ownGap, courtGap(a.courtId));
            const between = Math.abs(slot - a.slot) - 1;
            if (between < need && (!worst || between - need < worst.between - worst.need)) {
                worst = { athleteId: id, otherMatchId: a.matchId, between, need };
            }
        }
    }
    return worst;
}

function recordAppearance(match, courtId, slot, appearancesByAthlete) {
    (match._possibleAthletes || new Set()).forEach(id => {
        (appearancesByAthlete[id] = appearancesByAthlete[id] || []).push({ matchId: match.matchId, courtId, slot });
    });
}

function buildCategoryMeta(brackets) {
    const meta = {};
    brackets.forEach(b => {
        const cat = flatCategories.find(c => c.code === b.categoryCode);
        const info = cat ? vestInfoFor(cat) : null;
        const genPolicy = info ? info.vestGenPolicy : "either";
        meta[b.categoryCode] = {
            eligibleCourtIds: courts.filter(c => info == null || courtSupportsGenPolicy(c, genPolicy)).map(c => c.id),
            avgBirthYear: cat ? (cat.ageMin + cat.ageMax) / 2 : 0,
            pssSize: info ? info.pssSize : null,
            genPolicy,
            requiresPlexiHelmet: categoryRequiresPlexiHelmet(cat),
            durationSeconds: estimateMatchDurationSeconds(cat),
            homeCourtId: null,
        };
    });
    return meta;
}

// LOCK #3: one court per category. Pinned categories (dragged to a
// court by staff) go first; the rest by LPT on fight count.
function assignCategoriesToCourts(brackets, categoryMeta) {
    const load = {};
    courts.forEach(c => { load[c.id] = 0; });
    const unassignable = [];

    const items = brackets.map(b => ({
        b, meta: categoryMeta[b.categoryCode],
        count: b.rounds.reduce((s, r) => s + r.filter(m => m.status !== "walkover").length, 0),
    })).filter(x => x.count > 0);

    const place = (x, court) => { x.meta.homeCourtId = court.id; x.b.courtId = court.id; load[court.id] += x.count; };

    const free = [];
    items.forEach(x => {
        const pinId = categoryCourtPins[x.b.categoryCode];
        const pinned = pinId && x.meta.eligibleCourtIds.includes(pinId) ? courtById(pinId) : null;
        if (pinned) place(x, pinned); else free.push(x);
    });

    free.sort((a, b) => b.count - a.count);
    free.forEach(x => {
        const eligible = courts.filter(c => x.meta.eligibleCourtIds.includes(c.id));
        if (eligible.length === 0) { x.b.courtId = null; unassignable.push(x.b); return; }
        let best = null, bestScore = Infinity;
        eligible.forEach(c => {
            let score = load[c.id];
            if (x.meta.requiresPlexiHelmet && !c.plexiCapable) score += courtBalanceThreshold;
            const vn = c.vestNumbers || [];
            if (x.meta.pssSize != null && vn.length > 0 && !vn.includes(x.meta.pssSize)) score += 0.5;
            if (score < bestScore) { best = c; bestScore = score; }
        });
        place(x, best);
    });
    return { load, unassignable };
}

function checkEquipmentFor(meta, court, tracker, start) {
    const end = start + meta.durationSeconds + transferBufferSeconds;
    if (meta.requiresPlexiHelmet) {
        const p = checkPlexiAvailability(tracker, start, end, court.id);
        if (!p.ok) return { ok: false, reason: p.reason };
    }
    let resolvedGen = null;
    if (meta.pssSize != null) {
        const allowedGens = (!court.allowedVestGen || court.allowedVestGen === "any") ? ["gen2", "gen3"] : [court.allowedVestGen];
        const v = checkVestAvailability(tracker, meta.pssSize, meta.genPolicy, allowedGens, start, end, court.id);
        if (!v.ok) return { ok: false, reason: v.reason };
        resolvedGen = v.resolvedGen;
    }
    return { ok: true, start, end, resolvedGen };
}

function generateCourtOrdering(brackets) {
    const lookup = {};
    brackets.forEach(b => b.rounds.forEach(r => r.forEach(m => { lookup[m.matchId] = m; })));
    computePossibleAthletes(brackets);

    // Re-runnable (moveCategoryToCourt calls this again) — start clean.
    brackets.forEach(b => b.rounds.forEach(r => r.forEach(m => {
        m.courtId = null; m.queuePosition = null;
        delete m.scheduledWithRelaxedConstraints; delete m.unassignedReason;
        delete m.resolvedVestGen; delete m.equipmentConflict; delete m.restGapRelaxed;
    })));

    const categoryMeta = buildCategoryMeta(brackets);
    const { load, unassignable } = assignCategoriesToCourts(brackets, categoryMeta);

    const unassigned = [];
    unassignable.forEach(b => b.rounds.forEach(r => r.forEach(m => {
        if (m.status === "walkover") return;
        m.unassignedReason = "no court supports this category's required vest generation";
        unassigned.push(m);
    })));

    // depth = how many rounds still come AFTER this match in its
    // bracket. Scheduling deeper matches first (critical path) is what
    // lets a semi-final run early enough that its final can follow
    // with a proper rest gap, instead of the court having to wait.
    const pending = {};
    courts.forEach(c => { pending[c.id] = []; });
    brackets.forEach(b => {
        const meta = categoryMeta[b.categoryCode];
        if (!meta.homeCourtId || !pending[meta.homeCourtId]) return;
        b.rounds.forEach((round, roundIdx) => round.forEach(m => {
            if (m.status !== "walkover") {
                pending[meta.homeCourtId].push({ match: m, meta, roundIdx, depth: b.rounds.length - 1 - roundIdx });
            }
        }));
    });
    // Preference order (all SOFT): critical path, then the court's age
    // order, then round, then a stable tie-break.
    courts.forEach(c => pending[c.id].sort((a, b) => {
        if (a.depth !== b.depth) return b.depth - a.depth;
        const age = c.ageOrder === "youngest_first"
            ? b.meta.avgBirthYear - a.meta.avgBirthYear
            : a.meta.avgBirthYear - b.meta.avgBirthYear;
        if (age !== 0) return age;
        if (a.roundIdx !== b.roundIdx) return a.roundIdx - b.roundIdx;
        if (a.match.categoryCode !== b.match.categoryCode) return a.match.categoryCode < b.match.categoryCode ? -1 : 1;
        return a.match.matchNumber - b.match.matchNumber;
    }));

    const tracker = makeEquipmentTracker();
    const appearances = {};
    const clock = {}, slot = {};
    courts.forEach(c => { clock[c.id] = 0; slot[c.id] = 0; });

    let remaining = courts.reduce((n, c) => n + pending[c.id].length, 0);
    let placedCount = 0;

    // NO HOLDS: every tick, every court with work left takes its next
    // match immediately. Choice per court:
    //   1. rest gap OK + equipment free      -> normal
    //   2. rest gap OK, equipment not free   -> equipment relaxed
    //   3. nothing satisfies the rest gap    -> least-bad option,
    //      marked restGapRelaxed (only when no other order exists)
    while (remaining > 0) {
        let placedThisTick = false;
        for (const court of courts) {
            const list = pending[court.id];
            if (list.length === 0) continue;
            const t = slot[court.id];

            let restOk = -1, restOkEquip = -1, equipResult = null;
            let fallback = -1, fallbackSlack = -Infinity, fallbackInfo = null;
            for (let i = 0; i < list.length; i++) {
                const cand = list[i];
                const feedersDone = feederMatchesOf(cand.match, lookup)
                    .every(f => f.queuePosition != null && f.courtId === court.id);
                if (!feedersDone) continue;

                const v = restGapViolation(cand.match, court.id, t, appearances);
                if (!v) {
                    if (restOk === -1) restOk = i;
                    const eq = checkEquipmentFor(cand.meta, court, tracker, clock[court.id]);
                    if (eq.ok) { restOkEquip = i; equipResult = eq; break; }
                    continue;
                }
                const slack = v.between - v.need;
                if (slack > fallbackSlack) { fallback = i; fallbackSlack = slack; fallbackInfo = v; }
            }

            let pickIdx = -1, restRelaxed = null;
            if (restOkEquip !== -1) pickIdx = restOkEquip;
            else if (restOk !== -1) pickIdx = restOk;
            else if (fallback !== -1) { pickIdx = fallback; restRelaxed = fallbackInfo; }
            if (pickIdx === -1) continue; // nothing feeder-ready (can't happen within one court's own categories)

            const cand = list.splice(pickIdx, 1)[0];
            const m = cand.match;
            if (!equipResult || pickIdx !== restOkEquip) {
                const eq = checkEquipmentFor(cand.meta, court, tracker, clock[court.id]);
                equipResult = eq.ok ? eq : null;
            }

            m.courtId = court.id;
            m.queuePosition = t;
            recordAppearance(m, court.id, t, appearances);
            if (restRelaxed) m.restGapRelaxed = { between: Math.max(0, restRelaxed.between), need: restRelaxed.need };

            if (equipResult) {
                if (cand.meta.requiresPlexiHelmet) reservePlexi(tracker, equipResult.start, equipResult.end, court.id);
                if (equipResult.resolvedGen) {
                    reserveVest(tracker, cand.meta.pssSize, equipResult.resolvedGen, equipResult.start, equipResult.end, court.id);
                    m.resolvedVestGen = equipResult.resolvedGen;
                }
            } else if (cand.meta.requiresPlexiHelmet || cand.meta.pssSize != null) {
                m.scheduledWithRelaxedConstraints = true; // equipment not free at this slot
            }

            clock[court.id] += cand.meta.durationSeconds;
            slot[court.id]++;
            remaining--;
            placedCount++;
            placedThisTick = true;
        }
        if (!placedThisTick) break; // safety — should be unreachable
    }

    courts.forEach(c => pending[c.id].forEach(p => {
        p.match.unassignedReason = "could not be ordered (feeder missing)";
        unassigned.push(p.match);
    }));

    // The greedy pass can box itself in near the end of a court's day.
    // Repair: move single matches to other positions whenever that
    // strictly reduces missing rest. Positions stay back to back.
    improveCourtOrders(brackets, lookup);
    const allMatches = [];
    brackets.forEach(b => b.rounds.forEach(r => r.forEach(m => allMatches.push(m))));
    syncRestGapRelaxedFlags(findRestGapPairs(allMatches));

    return { placedCount, unassigned, courtLoad: load };
}

// Missing rest for one court's order, in "athlete-fights short":
// every (possible) athlete whose consecutive appearances are closer
// than the gap adds (need - between). Appearances on other courts
// are fixed and passed in as `external`.
function courtOrderCost(order, courtId, external) {
    const gapHere = courtGap(courtId);
    const last = {};
    let cost = 0;
    for (let pos = 0; pos < order.length; pos++) {
        for (const id of order[pos]._possibleAthletes || []) {
            if (id in last) {
                const between = pos - last[id] - 1;
                if (between < gapHere) cost += gapHere - between;
            }
            const ext = external[id];
            if (ext) for (const a of ext) {
                const need = Math.max(gapHere, courtGap(a.courtId));
                const between = Math.abs(pos - a.slot) - 1;
                if (between < need) cost += need - between;
            }
            last[id] = pos;
        }
    }
    return cost;
}

function improveCourtOrders(brackets, lookup) {
    const all = [];
    brackets.forEach(b => b.rounds.forEach(r => r.forEach(m => { if (m.status !== "walkover" && m.courtId) all.push(m); })));
    const dependents = {};
    all.forEach(m => feederMatchesOf(m, lookup).forEach(f => { (dependents[f.matchId] = dependents[f.matchId] || []).push(m); }));

    const deadline = Date.now() + 1500; // total budget across all courts
    courts.forEach(court => {
        let order = all.filter(m => m.courtId === court.id).sort((a, b) => a.queuePosition - b.queuePosition);
        if (order.length < 3) return;

        const external = {};
        all.filter(m => m.courtId !== court.id).forEach(m => (m._possibleAthletes || []).forEach(id => {
            (external[id] = external[id] || []).push({ slot: m.queuePosition, courtId: m.courtId });
        }));

        let cost = courtOrderCost(order, court.id, external);
        let improved = true;
        while (improved && cost > 0 && Date.now() < deadline) {
            improved = false;
            for (let i = 0; i < order.length && cost > 0 && Date.now() < deadline; i++) {
                const m = order[i];
                const rest = order.slice(0, i).concat(order.slice(i + 1));
                const idx = {};
                rest.forEach((x, k) => { idx[x.matchId] = k; });
                // m must go after all its feeders and before all its dependents
                let lo = 0, hi = rest.length;
                feederMatchesOf(m, lookup).forEach(f => { if (idx[f.matchId] != null) lo = Math.max(lo, idx[f.matchId] + 1); });
                (dependents[m.matchId] || []).forEach(d => { if (idx[d.matchId] != null) hi = Math.min(hi, idx[d.matchId]); });
                let bestJ = -1, bestCost = cost;
                for (let j = lo; j <= hi; j++) {
                    if (j === i) continue;
                    const cand = rest.slice(0, j).concat([m], rest.slice(j));
                    const c = courtOrderCost(cand, court.id, external);
                    if (c < bestCost) { bestCost = c; bestJ = j; }
                }
                if (bestJ !== -1) {
                    order = rest.slice(0, bestJ).concat([m], rest.slice(bestJ));
                    cost = bestCost;
                    improved = true;
                }
            }
        }
        order.forEach((m, k) => { m.queuePosition = k; });
    });
}

// Every consecutive pair of appearances of the same (possible) athlete
// that is closer than the required gap. Keyed unordered, deduped to
// the tightest pair. Used by the checker and by drag-and-drop.
function findRestGapPairs(matchList) {
    if (!matchList) computePossibleAthletes(generatedBrackets);
    const scheduled = (matchList || generatedMatches).filter(m => m.status !== "walkover" && m.courtId && m.queuePosition != null);
    const byAthlete = {};
    scheduled.forEach(m => (m._possibleAthletes || new Set()).forEach(id => {
        (byAthlete[id] = byAthlete[id] || []).push(m);
    }));
    const pairs = {};
    Object.values(byAthlete).forEach(list => {
        list.sort((a, b) => a.queuePosition - b.queuePosition);
        for (let i = 1; i < list.length; i++) {
            const a = list[i - 1], b = list[i];
            const between = b.queuePosition - a.queuePosition - 1;
            const need = Math.max(courtGap(a.courtId), courtGap(b.courtId));
            if (between >= need) continue;
            const key = [a.matchId, b.matchId].sort().join("|");
            if (!pairs[key] || between < pairs[key].between) pairs[key] = { key, a, b, between, need };
        }
    });
    return Object.values(pairs);
}

// After an accepted drag, the relaxed flag belongs on whichever match
// is now the LATER one of each remaining (pre-existing) short pair.
function syncRestGapRelaxedFlags(pairs) {
    generatedMatches.forEach(m => { delete m.restGapRelaxed; });
    pairs.forEach(p => {
        const later = p.a.queuePosition > p.b.queuePosition ? p.a : p.b;
        const prev = later.restGapRelaxed;
        if (!prev || p.between < prev.between) later.restGapRelaxed = { between: Math.max(0, p.between), need: p.need };
    });
}

// Dragging a match to ANOTHER court moves its whole category there
// (lock #3) and re-runs the scheduler with that category pinned.
function moveCategoryToCourt(categoryCode, courtId) {
    const bracket = generatedBrackets.find(b => b.categoryCode === categoryCode);
    const court = courtById(courtId);
    if (!bracket || !court) { renderCourtColumns(); return; }

    const cat = flatCategories.find(c => c.code === categoryCode);
    const info = cat ? vestInfoFor(cat) : null;
    if (info && !courtSupportsGenPolicy(court, info.vestGenPolicy)) {
        showFlash(`${court.label} is locked to a vest generation ${bracket.categoryLabel} can't use.`, true);
        renderCourtColumns();
        return;
    }
    if (!confirm(`A category runs on one court only. Move ALL of "${bracket.categoryLabel}" to ${court.label}?\n\nCourt order will be recomputed — manual reordering is lost.`)) {
        renderCourtColumns();
        return;
    }
    categoryCourtPins[categoryCode] = courtId;
    lastOrderingResult = generateCourtOrdering(generatedBrackets);
    computeMatchNumbers();
    revalidateEquipmentAfterManualEdit();
    rebuildMatchById();
    refreshHardLockReport();
    renderCourtColumns();
    renderBracketsPreview();
}

function dependencyOrderViolation(orderedCourtMatches) {
    const idx = {};
    orderedCourtMatches.forEach((m, i) => { idx[m.matchId] = i; });
    for (const m of orderedCourtMatches) {
        for (const f of feederMatchesOf(m, matchById)) {
            if (idx[f.matchId] != null && idx[f.matchId] > idx[m.matchId]) {
                return `Match ${formatMatchNumber(m)} can't run before its feeder ${formatMatchNumber(f)}.`;
            }
        }
    }
    return null;
}

// KYORUGI fight numbers: court ordinal * 100 + 1-indexed position in
// that court's queue.
function computeMatchNumbers() {
    courts.forEach((court, courtIdx) => {
        const ordinal = courtIdx + 1;
        const courtMatches = generatedMatches
            .filter(m => m.courtId === court.id && m.queuePosition != null)
            .sort((a, b) => a.queuePosition - b.queuePosition);
        courtMatches.forEach((m, i) => { m.displayNumber = ordinal * 100 + (i + 1); });
    });
}

async function generateEverything() {
    if (!ensureReadyToGenerate()) return;
    if (!selectedPssHitLevelSetId) {
        showFlash("No PSS hit-level table selected — upload one via upload_pss_hitlevels.py first.", true);
        return;
    }

    const placementFn = PLACEMENT_STRATEGIES[document.getElementById("placementSelect").value];
    const { skippedSingleEntryCount, totalConflicts } = await buildAllBrackets({
        categories: flatCategories,
        systemKey: "single_elimination",
        build: (cat, seeded) => generateSingleElimination(cat.code, seeded, placementFn),
        decorateMatch: (m, cat) => {
            const vestInfo = vestInfoFor(cat);
            m.pssSize = vestInfo ? vestInfo.pssSize : null;
            m.hitLevel = vestInfo ? vestInfo.hitLevel : null;
            m.pssHitLevelSetId = selectedPssHitLevelSetId;
            m.requiresPlexiHelmet = categoryRequiresPlexiHelmet(cat);
        },
        extraBracketFields: () => ({ pssHitLevelSetId: selectedPssHitLevelSetId, durationSeconds: null }),
    });

    const orderingResult = generateCourtOrdering(generatedBrackets);
    lastOrderingResult = orderingResult;
    computeMatchNumbers();
    revalidateEquipmentAfterManualEdit();
    rebuildMatchById();
    const lockReport = refreshHardLockReport();

    const loads = courts.map(c => `${escapeHtml(c.label)}: ${orderingResult.courtLoad[c.id] || 0}`).join(", ");
    showGenerationResults([
        `${generatedBrackets.length} bracket(s) generated`,
        `${orderingResult.placedCount} match(es) scheduled onto courts`,
        `fights per court — ${loads}`,
        skippedSingleEntryCount > 0 && `<span style="color:#b45309;">${skippedSingleEntryCount} categor${skippedSingleEntryCount === 1 ? "y" : "ies"} skipped (only 1 entrant, nothing to bracket)</span>`,
        totalConflicts > 0 && `<span style="color:#b45309;">${totalConflicts} unavoidable same-club first-round pair(s)</span>`,
        orderingResult.unassigned.length > 0 && `<span style="color:#b91c1c;">${orderingResult.unassigned.length} match(es) not scheduled (check vest-gen court locks)</span>`,
        lockReport.restGapRelaxed.length > 0 && `<span style="color:#b45309;">${lockReport.restGapRelaxed.length} relaxed rest gap(s)</span>`,
    ], lockReport);
}

// ── Rendering: court columns with drag-and-drop ─────────────────────
let draggedMatchId = null;

function renderCourtColumns() {
    const el = document.getElementById("courtColumns");

    el.innerHTML = courts.map(court => {
        const matches = generatedMatches
            .filter(m => m.courtId === court.id && m.queuePosition != null)
            .sort((a, b) => a.queuePosition - b.queuePosition);
        const body = matches.map(m => renderCourtMatchCard(m)).join("");
        return `
            <div class="bb-court-column" data-court-id="${court.id}"
                ondragover="onColumnDragOver(event, this)" ondragleave="onColumnDragLeave(event, this)" ondrop="onColumnDrop(event, this)">
                <div class="bb-court-column-header">${escapeHtml(court.label)} <span class="text-muted" style="font-weight:400;">· ${matches.length} fights</span></div>
                <div class="bb-court-column-body">
                    ${body || `<p class="text-muted" style="font-size:0.82rem; padding: 0.5rem 0;">No matches assigned.</p>`}
                </div>
            </div>
        `;
    }).join("");

    const unassignedEl = document.getElementById("unassignedWarning");
    const unassignedMatches = generatedMatches.filter(m => m.status !== "walkover" && !m.courtId);
    const relaxedMatches = generatedMatches.filter(m => m.scheduledWithRelaxedConstraints);
    const restRelaxedMatches = generatedMatches.filter(m => m.restGapRelaxed);
    const conflictMatches = generatedMatches.filter(m => m.equipmentConflict);
    if (unassignedMatches.length > 0 || relaxedMatches.length > 0 || conflictMatches.length > 0 || restRelaxedMatches.length > 0) {
        unassignedEl.classList.remove("hidden");
        const reasons = [...new Set(unassignedMatches.map(m => m.unassignedReason || "no eligible court"))];
        unassignedEl.innerHTML = `
            ${unassignedMatches.length > 0 ? `<p style="color:#b91c1c; font-size:0.85rem;">
                ${unassignedMatches.length} match(es) couldn't be scheduled — ${escapeHtml(reasons.join("; "))}.</p>` : ""}
            ${conflictMatches.length > 0 ? `<p style="color:#b91c1c; font-size:0.85rem;">
                ${conflictMatches.length} match(es) have an equipment conflict (hover the ⚠ badge) — move the match or free up equipment nearby.</p>` : ""}
            ${relaxedMatches.length > 0 ? `<p style="color:#b45309; font-size:0.85rem;">
                ${relaxedMatches.length} match(es) were placed without free equipment — vest/helmet timing is not guaranteed.</p>` : ""}
            ${restRelaxedMatches.length > 0 ? `<p style="color:#b45309; font-size:0.85rem;">
                ${restRelaxedMatches.length} match(es) run with less rest than the court's minimum because no other order was possible on that court (see the ⚠ rest badge).</p>` : ""}
        `;
    } else {
        unassignedEl.classList.add("hidden");
    }
}

// A solo cut-off match has no red corner — the card shows "<name> — solo".
function renderCourtMatchCard(m) {
    const bracket = generatedBrackets.find(b => b.categoryCode === m.categoryCode);
    const n1 = participantLabel(bracket.entries, m.blue);
    const n2 = m.red ? participantLabel(bracket.entries, m.red) : null;
    const badge = m.status === "pending" ? `<span class="badge badge-grey">pending</span>` : "";
    const equipBadge = m.resolvedVestGen ? `<span class="badge badge-grey">${escapeHtml(m.resolvedVestGen)}</span>` : "";
    const plexiBadge = m.requiresPlexiHelmet ? `<span class="badge badge-grey">plexi</span>` : "";
    const relaxedBadge = m.scheduledWithRelaxedConstraints ? `<span class="badge" style="background:#fef3c7; color:#b45309;" title="Placed without free equipment">equip relaxed</span>` : "";
    const restBadge = m.restGapRelaxed
        ? `<span class="badge" style="background:#fef3c7; color:#b45309;" title="Only ${m.restGapRelaxed.between} fight(s) of rest before this match (court minimum ${m.restGapRelaxed.need}) — no other order was possible">⚠ rest ${m.restGapRelaxed.between}/${m.restGapRelaxed.need}</span>`
        : "";
    const conflictBadge = m.equipmentConflict
        ? `<span class="badge" style="background:#fee2e2; color:#b91c1c;" title="${escapeAttr(m.equipmentConflict)}">⚠ ${m.equipmentConflict.toUpperCase().includes("VEST") && m.equipmentConflict.toUpperCase().includes("HELMET") ? "vest+helmet" : m.equipmentConflict.toUpperCase().includes("HELMET") ? "helmet" : "vest"}</span>`
        : "";
    const title = n2 ? `${escapeHtml(n1)} vs ${escapeHtml(n2)}` : `${escapeHtml(n1)} <span class="text-muted">— solo</span>`;
    return `
        <div class="bb-court-match" draggable="true" data-match-id="${m.matchId}"
            ondragstart="onMatchDragStart(event, this)" ondragend="onMatchDragEnd(event, this)">
            <div class="text-muted" style="font-size:0.72rem;">${formatMatchNumber(m)} · ${m.roundPhase ? escapeHtml(m.roundPhase) + " · " : ""}${escapeHtml(bracket.categoryLabel)} ${badge} ${equipBadge} ${plexiBadge} ${relaxedBadge} ${restBadge} ${conflictBadge}</div>
            <div style="font-size:0.88rem; font-weight:600;">${title}</div>
        </div>
    `;
}

function onMatchDragStart(event, el) {
    draggedMatchId = el.dataset.matchId;
    el.classList.add("bb-court-match--dragging");
}

function onMatchDragEnd(event, el) {
    el.classList.remove("bb-court-match--dragging");
    removeDropIndicator();
    document.querySelectorAll(".bb-court-column--drop-target").forEach(c => c.classList.remove("bb-court-column--drop-target"));
}

let dropIndicatorEl = null;

function ensureDropIndicator() {
    if (!dropIndicatorEl) {
        dropIndicatorEl = document.createElement("div");
        dropIndicatorEl.className = "bb-drop-indicator";
    }
    return dropIndicatorEl;
}

function removeDropIndicator() {
    if (dropIndicatorEl && dropIndicatorEl.parentNode) dropIndicatorEl.parentNode.removeChild(dropIndicatorEl);
}

// Shared by both the live dragover preview and the actual drop.
function computeDropIndex(bodyEl, clientY) {
    const cards = [...bodyEl.querySelectorAll(".bb-court-match")];
    let dropIndex = cards.length;
    for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) { dropIndex = i; break; }
    }
    return { dropIndex, cards };
}

function onColumnDragOver(event, columnEl) {
    event.preventDefault();
    if (!draggedMatchId) return;

    const bodyEl = columnEl.querySelector(".bb-court-column-body");
    const { dropIndex, cards } = computeDropIndex(bodyEl, event.clientY);

    const indicator = ensureDropIndicator();
    if (dropIndex >= cards.length) {
        bodyEl.appendChild(indicator);
    } else {
        bodyEl.insertBefore(indicator, cards[dropIndex]);
    }

    document.querySelectorAll(".bb-court-column--drop-target").forEach(c => {
        if (c !== columnEl) c.classList.remove("bb-court-column--drop-target");
    });
    columnEl.classList.add("bb-court-column--drop-target");
}

function onColumnDragLeave(event, columnEl) {
    if (!columnEl.contains(event.relatedTarget)) {
        columnEl.classList.remove("bb-court-column--drop-target");
    }
}

function onColumnDrop(event, columnEl) {
    event.preventDefault();
    columnEl.classList.remove("bb-court-column--drop-target");
    removeDropIndicator();
    if (!draggedMatchId) return;
    const targetCourtId = columnEl.dataset.courtId;
    const moved = generatedMatches.find(m => m.matchId === draggedMatchId);
    draggedMatchId = null;
    if (!moved) return;

    // LOCK #3: a single match can't leave its category's court.
    if (moved.courtId !== targetCourtId) {
        moveCategoryToCourt(moved.categoryCode, targetCourtId);
        return;
    }

    const bodyEl = columnEl.querySelector(".bb-court-column-body");
    const { dropIndex } = computeDropIndex(bodyEl, event.clientY);

    const columnMatches = generatedMatches
        .filter(m => m.courtId === targetCourtId && m.matchId !== moved.matchId && m.queuePosition != null)
        .sort((a, b) => a.queuePosition - b.queuePosition);
    columnMatches.splice(dropIndex, 0, moved);

    const depError = dependencyOrderViolation(columnMatches);
    if (depError) { showFlash(depError, true); renderCourtColumns(); return; }

    // LOCK #1 on drags: reject any drop that creates a new short rest
    // pair or makes an existing (already relaxed) one shorter.
    const before = {};
    findRestGapPairs().forEach(p => { before[p.key] = p.between; });
    const previous = columnMatches.map(m => [m, m.queuePosition]);

    columnMatches.forEach((m, i) => { m.queuePosition = i; }); // back to back, no holds

    const after = findRestGapPairs();
    const worse = after.find(p => !(p.key in before) || p.between < before[p.key]);
    if (worse) {
        previous.forEach(([m, pos]) => { m.queuePosition = pos; });
        const [first, later] = worse.a.queuePosition <= worse.b.queuePosition ? [worse.a, worse.b] : [worse.b, worse.a];
        showFlash(`Drop rejected — ${formatMatchNumber(first)} and ${formatMatchNumber(later)} would share an athlete with only ${Math.max(0, worse.between)} fight(s) of rest (needs ${worse.need}).`, true);
        renderCourtColumns();
        return;
    }
    syncRestGapRelaxedFlags(after);

    computeMatchNumbers();
    revalidateEquipmentAfterManualEdit();
    refreshHardLockReport();
    renderCourtColumns();
    renderBracketsPreview(); // "101 Winner" labels may reference a match whose number just changed
}

init();