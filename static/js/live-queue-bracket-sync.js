/* ════════════════════════════════════════════════════════════════════
 * live-queue-bracket-sync.js — keeps the saved bracket docs
 * (tournaments/{id}/brackets) in step with the live match docs when an
 * athlete is replaced. Loaded by live_queue_base.html right AFTER
 * live-queue-common.js.
 *
 * WHY: replacing a corner in the live queue only rewrote that one match
 * doc. The bracket doc's `entries` kept the old athlete, so bracket
 * sheets, club sheets, standings and anything else reading the bracket
 * doc still showed them. Any later-round match that already held the old
 * athlete kept them too.
 *
 * TWO WAYS IN
 *   - saveMatchEdits() (common file) calls syncBracketForReplacement()
 *     and adds its writes to the SAME batch as the match edit. From now on
 *     every replacement also updates the bracket doc and every other match
 *     of that category that still shows the old athlete.
 *   - 🔧 Sync Brackets (toolbar) → openBracketSyncModal(): a one-off repair
 *     for replacements made before this existed. It lists what it would
 *     change and writes only when you press Apply. From the console:
 *        const plans = await planAllBracketSyncs();
 *        plans.forEach(p => console.log(p.categoryLabel, p.changes, p.notes));
 *        await applyBracketSyncs(plans);
 *
 * HOW A REPLACEMENT IS FOUND
 *   single elimination     the tree is rebuilt exactly as it was pushed
 *                          (BracketCore, saved seed order + placement).
 *                          Each slot's athlete is compared with the live
 *                          match doc in that slot (bracketRound /
 *                          bracketMatchNumber).
 *   cut-off / round robin  there are no slots. An entry that is in no
 *                          match any more is paired with an athlete who is
 *                          in the matches but has no entry. Anything that
 *                          can't be paired is listed and left alone.
 *
 * FREEZING THE TREE: club-spread placement depends on each entry's club
 * and country. Re-running it on edited entries could pair round 1
 * differently from what was pushed. The first sync of an elimination
 * bracket therefore saves `slotOrder` (entryId per slot, null = bye).
 * From then on every rebuild uses that order (eliminationTreeFor).
 *
 * A replacing entry keeps the old entry's seed and records
 * `replacedEntryIds`, so a placement computed for the old entry carries
 * over to the new one on the sheets.
 * ════════════════════════════════════════════════════════════════════ */
"use strict";

function bracketsCollection() {
    return fsDb.collection("tournaments").doc(TOURNAMENT_ID).collection("brackets");
}

async function loadBracketDocRef(categoryCode) {
    const snap = await bracketsCollection().where("categoryCode", "==", categoryCode).limit(1).get();
    return snap.empty ? null : { ref: snap.docs[0].ref, data: snap.docs[0].data() };
}

function categoryMatchList(categoryCode) {
    return [...matchesById.values()].filter(m => m.categoryCode === categoryCode);
}

function sortedBracketEntries(bracketDoc) {
    return (bracketDoc.entries || []).slice().sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
}

// ── The elimination tree, exactly as pushed ─────────────────────────
function hasValidSlotOrder(bracketDoc, entries) {
    const order = bracketDoc.slotOrder;
    if (!Array.isArray(order) || order.length !== BracketCore.nextPowerOfTwo(entries.length)) return false;
    const ids = order.filter(Boolean);
    const known = new Set(entries.map(e => e.entryId));
    return ids.length === entries.length && new Set(ids).size === ids.length && ids.every(id => known.has(id));
}

// Used by reconstructBracketFromFirestore() in the common file as well.
function eliminationTreeFor(bracketDoc) {
    const entries = sortedBracketEntries(bracketDoc);
    let placementFn;
    if (hasValidSlotOrder(bracketDoc, entries)) {
        const byId = new Map(entries.map(e => [e.entryId, e]));
        placementFn = (_entries, size) => Array.from({ length: size }, (_, i) => byId.get(bracketDoc.slotOrder[i]) || null);
    } else {
        placementFn = BracketCore.PLACEMENT_STRATEGIES[bracketDoc.placementStrategy] || BracketCore.PLACEMENT_STRATEGIES.standard;
    }
    return BracketCore.generateSingleElimination(bracketDoc.categoryCode, entries, placementFn);
}

function slotOrderOf(built) {
    const order = new Array(built.bracketSize).fill(null);
    Object.entries(built.entrySlotIndex || {}).forEach(([id, idx]) => { order[idx] = id; });
    return order;
}

// ── Athlete fields shared by corners and entries ────────────────────
function athleteFieldsOf(c) {
    const out = {
        entryId: c.entryId,
        athleteIds: Array.isArray(c.athleteIds) && c.athleteIds.length ? c.athleteIds : [c.entryId],
        name: c.name || "",
        clubId: c.clubId ?? null,
        clubName: c.clubName ?? null,
        country: c.country ?? null,
    };
    const assoc = c.associationIds || (c.associationId ? [c.associationId] : null);
    if (assoc) out.associationIds = assoc;
    return out;
}

function entryReplacing(oldEntry, corner) {
    const fields = athleteFieldsOf(corner);
    return {
        ...fields,
        seed: oldEntry.seed ?? null,
        associationIds: fields.associationIds || [],
        replacedEntryIds: [...(oldEntry.replacedEntryIds || []), oldEntry.entryId],
    };
}

// ── The plan for one category ───────────────────────────────────────
// matches: this category's match docs, as they are (repair) or as they
//          are about to be saved (corner replacement)
// known:   { oldEntryId: newCorner } — replacements picked right now
// -> { categoryCode, categoryLabel, changes: [{oldId, oldName, newName}],
//      matchFixes: [{id, label, updates}], bracketUpdate | null, notes }
function planBracketSync(bracketDoc, matches, known) {
    const entries = bracketDoc.entries || [];
    const entryById = new Map(entries.map(e => [e.entryId, e]));
    const nameOf = id => (entryById.get(id) || {}).name || id;
    const replacements = {}; // old entryId -> new corner
    const notes = [];

    Object.entries(known || {}).forEach(([oldId, c]) => {
        if (entryById.has(oldId) && c && c.entryId && c.entryId !== oldId) replacements[oldId] = c;
    });

    const elimination = !bracketDoc.system || bracketDoc.system === "single_elimination";
    let slotOrder = null;

    if (elimination) {
        if (entries.length >= 2) {
            const built = eliminationTreeFor(bracketDoc);
            const live = {};
            matches.forEach(m => {
                if (m.bracketRound != null && m.bracketMatchNumber != null) live[`${m.bracketRound}_${m.bracketMatchNumber}`] = m;
            });
            built.rounds.forEach(round => round.forEach(bm => {
                if (bm.status === "walkover") return;
                const lm = live[`${bm.round}_${bm.matchNumber}`];
                if (!lm) return;
                ["blue", "red"].forEach(side => {
                    const was = bm[side], now = lm[side];
                    if (!was || !was.entryId || !now || !now.entryId || was.entryId === now.entryId) return;
                    if (!replacements[was.entryId]) replacements[was.entryId] = now;
                });
            }));
            slotOrder = hasValidSlotOrder(bracketDoc, sortedBracketEntries(bracketDoc)) ? bracketDoc.slotOrder : slotOrderOf(built);
        }
    } else {
        // Cut-off / round robin: compare who is in the matches with who is in the bracket.
        const inMatches = new Map();
        matches.forEach(m => ["blue", "red"].forEach(side => {
            const c = m[side];
            if (c && c.entryId) inMatches.set(c.entryId, c);
        }));
        const takenNew = new Set(Object.values(replacements).map(c => c.entryId));
        const missing = entries.filter(e => !replacements[e.entryId] && !inMatches.has(e.entryId));
        const added = [...inMatches.values()].filter(c => !entryById.has(c.entryId) && !takenNew.has(c.entryId));
        const n = Math.min(missing.length, added.length);
        for (let i = 0; i < n; i++) replacements[missing[i].entryId] = added[i];
        if (missing.length > n) {
            notes.push(`In the bracket but in no match (left as they are): ${missing.slice(n).map(e => e.name || e.entryId).join(", ")}`);
        }
        if (added.length > n) {
            notes.push(`In a match but not in the bracket, nobody to replace (left as they are): ${added.slice(n).map(c => c.name || c.entryId).join(", ")}`);
        }
    }

    // Don't create a second entry for an athlete who already has one, or
    // let two old entries turn into the same athlete.
    const oldIds = new Set(Object.keys(replacements));
    const usedNew = new Set();
    Object.entries(replacements).forEach(([oldId, c]) => {
        if ((entryById.has(c.entryId) && !oldIds.has(c.entryId)) || usedNew.has(c.entryId)) {
            notes.push(`${nameOf(oldId)} → ${c.name || c.entryId}: ${c.name || c.entryId} is already in this bracket — not changed, check this category by hand.`);
            delete replacements[oldId];
            return;
        }
        usedNew.add(c.entryId);
    });

    const changes = Object.entries(replacements).map(([oldId, c]) => ({ oldId, oldName: nameOf(oldId), newName: c.name || c.entryId }));

    // Every match of the category that still shows a replaced athlete.
    const matchFixes = [];
    matches.forEach(m => {
        const updates = {};
        ["blue", "red"].forEach(side => {
            const c = m[side];
            const r = c && c.entryId && replacements[c.entryId];
            if (r) updates[side] = athleteFieldsOf(r);
        });
        if (m.winnerEntryId && replacements[m.winnerEntryId]) updates.winnerEntryId = replacements[m.winnerEntryId].entryId;
        if (Object.keys(updates).length) {
            matchFixes.push({ id: m.id, label: `#${m.displayNumber ?? "?"} ${m.roundPhase || ""}`.trim(), updates });
        }
    });

    let bracketUpdate = null;
    if (changes.length) {
        bracketUpdate = {
            entries: entries.map(e => (replacements[e.entryId] ? entryReplacing(e, replacements[e.entryId]) : e)),
            entriesSyncedAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        if (slotOrder) bracketUpdate.slotOrder = slotOrder.map(id => (id && replacements[id] ? replacements[id].entryId : id));
    }

    return {
        categoryCode: bracketDoc.categoryCode,
        categoryLabel: bracketDoc.categoryLabel || bracketDoc.categoryCode,
        changes, matchFixes, bracketUpdate, notes,
    };
}

// ── Hook: saving a corner replacement (saveMatchEdits) ──────────────
// Adds the bracket doc update and the other matches' fixes to `batch`.
// May set updates.winnerEntryId when the edited match's winner was the
// replaced athlete. -> notes to show the operator ([] when all is fine).
async function syncBracketForReplacement(m, updates, known, batch) {
    if (!m.categoryCode) return [];
    const found = await loadBracketDocRef(m.categoryCode);
    if (!found) return []; // inserted / exhibition match — no bracket to update

    const merged = {
        ...m, ...updates,
        blue: updates.blue ? { ...(m.blue || {}), ...updates.blue } : m.blue,
        red: updates.red ? { ...(m.red || {}), ...updates.red } : m.red,
    };
    const matches = categoryMatchList(m.categoryCode).map(x => (x.id === m.id ? merged : x));
    const plan = planBracketSync(found.data, matches, known);

    plan.matchFixes.forEach(f => {
        if (f.id === m.id) {
            if ("winnerEntryId" in f.updates) updates.winnerEntryId = f.updates.winnerEntryId;
            return;
        }
        batch.set(matchDocRef(f.id), f.updates, { merge: true });
    });
    if (plan.bracketUpdate) batch.set(found.ref, plan.bracketUpdate, { merge: true });
    return plan.notes;
}

// ── Repair: every category at once ──────────────────────────────────
async function planAllBracketSyncs() {
    const snap = await bracketsCollection().get();
    const plans = [];
    snap.forEach(doc => {
        const data = doc.data();
        if (!data.categoryCode) return;
        const plan = planBracketSync(data, categoryMatchList(data.categoryCode), {});
        plan.ref = doc.ref;
        if (plan.changes.length || plan.matchFixes.length || plan.notes.length) plans.push(plan);
    });
    return plans.sort((a, b) => String(a.categoryLabel).localeCompare(String(b.categoryLabel)));
}

async function applyBracketSyncs(plans) {
    const writes = [];
    plans.forEach(p => {
        if (p.bracketUpdate) writes.push([p.ref, p.bracketUpdate]);
        p.matchFixes.forEach(f => writes.push([matchDocRef(f.id), f.updates]));
    });
    const CHUNK = 400; // Firestore batches cap at 500 writes
    for (let i = 0; i < writes.length; i += CHUNK) {
        const batch = fsDb.batch();
        writes.slice(i, i + CHUNK).forEach(([ref, data]) => batch.set(ref, data, { merge: true }));
        await batch.commit();
    }
    return writes.length;
}

let bracketSyncPlans = [];

async function openBracketSyncModal() {
    openModal(`
        <div class="lq-modal-header">
            <h3>Sync Brackets with Matches</h3>
            <button class="lq-modal-close" onclick="closeModal()">&times;</button>
        </div>
        <div class="lq-modal-body">
            <p class="lq-field-hint" style="margin-bottom:1rem;">
                Finds athletes replaced in the live queue who are still in the saved bracket, and matches of
                the same category that still show the old athlete. Nothing is written until you press Apply.
            </p>
            <div id="bracket-sync-list"><p class="lq-field-hint">Comparing brackets with matches…</p></div>
            <div id="bracket-sync-error" class="lq-alert-error hidden"></div>
            <div class="lq-modal-actions">
                <button class="btn btn-primary" id="bracket-sync-apply-btn" disabled onclick="applyBracketSyncFromModal()">Apply</button>
                <button class="btn btn-ghost" onclick="closeModal()">Close</button>
            </div>
        </div>
    `);

    const listEl = () => document.getElementById("bracket-sync-list");
    try {
        bracketSyncPlans = await planAllBracketSyncs();
    } catch (err) {
        console.error("Bracket sync check failed", err);
        if (listEl()) listEl().innerHTML = `<div class="lq-alert-error">Couldn't compare: ${escapeHtml(err.message)}</div>`;
        return;
    }
    if (!listEl()) return; // closed while loading

    if (bracketSyncPlans.length === 0) {
        listEl().innerHTML = `<p class="lq-field-hint">Every bracket matches its live matches — nothing to fix.</p>`;
        return;
    }

    const fixable = bracketSyncPlans.filter(p => p.changes.length || p.matchFixes.length);
    listEl().innerHTML = bracketSyncPlans.map(p => `
        <div style="padding:.5rem 0; border-bottom:1px solid var(--lq-border); font-size:.85rem;">
            <strong>${escapeHtml(p.categoryLabel)}</strong>
            ${p.changes.map(c => `<div>${escapeHtml(c.oldName)} → <strong>${escapeHtml(c.newName)}</strong></div>`).join("")}
            ${p.matchFixes.length ? `<div style="color:var(--lq-muted); font-size:.78rem;">${p.matchFixes.length} match(es) still show the old athlete: ${escapeHtml(p.matchFixes.map(f => f.label).join(", "))}</div>` : ""}
            ${p.notes.map(n => `<div style="color:var(--lq-amber); font-size:.78rem;">⚠ ${escapeHtml(n)}</div>`).join("")}
        </div>
    `).join("");
    document.getElementById("bracket-sync-apply-btn").disabled = fixable.length === 0;
}

async function applyBracketSyncFromModal() {
    const btn = document.getElementById("bracket-sync-apply-btn");
    const errEl = document.getElementById("bracket-sync-error");
    errEl.classList.add("hidden");
    btn.disabled = true;
    btn.textContent = "Applying…";
    try {
        const count = await applyBracketSyncs(bracketSyncPlans);
        closeModal();
        alert(`Done — ${count} document(s) updated.`);
    } catch (err) {
        console.error("Bracket sync failed", err);
        errEl.textContent = `Failed: ${err.message}`;
        errEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Apply";
    }
}