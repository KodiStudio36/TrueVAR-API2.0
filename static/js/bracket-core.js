/* ════════════════════════════════════════════════════════════════════
 * bracket-core.js — shared single-elimination bracket builder.
 *
 * Pure functions, no DOM, no Firestore. Exposed as window.BracketCore.
 *
 * Used by:
 *   - bracket_builder.html  → generates brackets before push
 *   - live_queue.html       → rebuilds the SAME tree from the saved bracket
 *                             doc (entries + seed + placementStrategy)
 *
 * Both pages MUST run this exact code. The live queue reconstructs the
 * tree by re-running placement on the saved seed order; if its placement
 * code ever drifts from the builder's, the rebuilt sheet silently shows
 * different round-1 pairs than the ones actually pushed. (Before this
 * file existed, live_queue.html still carried the old greedy
 * "club_country_spread" swapper while the builder used the exact solver
 * below — so reprinted club-spread brackets could be wrong.)
 * ════════════════════════════════════════════════════════════════════ */
(function (global) {
    "use strict";

    // ── Small helpers ───────────────────────────────────────────────────
    function nextPowerOfTwo(n) {
        let p = 1;
        while (p < n) p *= 2;
        return p;
    }

    function sameClub(a, b) {
        return !!(a && b && a.clubId && b.clubId && a.clubId === b.clubId);
    }

    function sameCountry(a, b) {
        return !!(a && b && a.country && b.country && a.country === b.country);
    }

    // Short phase code stored on every match as `roundPhase`.
    function roundPhaseCode(playersEntering) {
        if (playersEntering === 2) return "F";
        if (playersEntering === 4) return "SF";
        if (playersEntering === 8) return "QF";
        return `R${playersEntering}`;
    }

    // Long label printed across the top of the draw sheet.
    function roundLabelText(playersEntering) {
        if (playersEntering === 2) return "Final";
        if (playersEntering === 4) return "Semifinals";
        if (playersEntering === 8) return "Quarterfinals";
        return `Round of ${playersEntering}`;
    }

    // Corner written onto a match doc. clubName travels with clubId so
    // court-side apps can show the club without another lookup.
    function cornerFromEntry(e) {
        return e
            ? { entryId: e.entryId, athleteIds: e.athleteIds, name: e.name, country: e.country, clubId: e.clubId, clubName: e.clubName || null }
            : { entryId: null, source: null };
    }

    // ── Seeding table ───────────────────────────────────────────────────
    // Recursive halving: seeds 1 & 2 in opposite halves, 1-4 in different
    // quarters, etc.
    function standardSeedSlotOrder(bracketSize) {
        let order = [1];
        while (order.length < bracketSize) {
            const n = order.length * 2;
            const next = [];
            order.forEach(s => { next.push(s); next.push(n + 1 - s); });
            order = next;
        }
        return order;
    }

    function placeStandard(seededEntries, bracketSize) {
        const slotOrder = standardSeedSlotOrder(bracketSize);
        const slots = new Array(bracketSize).fill(null);
        slotOrder.forEach((seed, i) => { slots[i] = seededEntries[seed - 1] || null; }); // null = bye
        return slots;
    }

    // ── Round-1 club clash solver (HARD LOCK #2) ────────────────────────
    // Exact branch-and-bound over perfect matchings:
    //   primary cost   = same-club pairs (weight 1000)
    //   secondary cost = same-country pairs (weight 1, tie-break only)
    // Phase 1 keeps byes on top seeds; phase 2 lets byes move only if that
    // removes a same-club pair. Deterministic for a given input order,
    // which is what lets live_queue.html reproduce the builder's tree.
    const CLUB_CLASH_COST = 1000;
    const COUNTRY_CLASH_COST = 1;
    const SEEDING_NODE_LIMIT = 40000;

    function solveMinClashPairing(items, nodeLimit) {
        const n = items.length;
        if (n === 0) return { cost: 0, pairs: [], proven: true };

        const C = [];
        for (let i = 0; i < n; i++) {
            const row = new Array(n);
            for (let j = 0; j < n; j++) {
                const a = items[i], b = items[j];
                if (i === j || (a.bye && b.bye)) row[j] = Infinity;
                else if (a.bye) row[j] = b.byeCost || 0;
                else if (b.bye) row[j] = a.byeCost || 0;
                else row[j] = (sameClub(a.entry, b.entry) ? CLUB_CLASH_COST : 0)
                    + (sameCountry(a.entry, b.entry) ? COUNTRY_CLASH_COST : 0);
            }
            C.push(row);
        }

        const used = new Array(n).fill(false);
        let freeByes = items.filter(x => x.bye).length;
        let freeReals = n - freeByes;
        const cur = [];
        let best = Infinity, bestPairs = null, nodes = 0, exhausted = true;

        function dfs(acc) {
            if (++nodes > nodeLimit) { exhausted = false; return; }

            let pick = -1, pickMin = -1, pickCount = Infinity, lbSum = 0;
            for (let i = 0; i < n; i++) {
                if (used[i]) continue;
                let min = Infinity, count = 0;
                for (let j = 0; j < n; j++) {
                    if (used[j] || j === i) continue;
                    const c = C[i][j];
                    if (c < min) { min = c; count = 1; } else if (c === min) count++;
                }
                if (min === Infinity) return;
                lbSum += min;
                if (min > pickMin || (min === pickMin && count < pickCount)) { pick = i; pickMin = min; pickCount = count; }
            }
            if (pick === -1) {
                if (acc < best) { best = acc; bestPairs = cur.slice(); }
                return;
            }
            if (acc + lbSum / 2 >= best) return;

            const partners = [];
            for (let j = 0; j < n; j++) if (!used[j] && j !== pick && C[pick][j] !== Infinity) partners.push(j);
            partners.sort((x, y) => C[pick][x] - C[pick][y]);

            used[pick] = true;
            for (const j of partners) {
                if (acc + C[pick][j] >= best) break;
                const bothReal = !items[pick].bye && !items[j].bye;
                if (bothReal && freeByes > freeReals - 2) continue;
                used[j] = true; cur.push([pick, j]);
                if (bothReal) freeReals -= 2; else { freeReals -= 1; freeByes -= 1; }
                dfs(acc + C[pick][j]);
                if (bothReal) freeReals += 2; else { freeReals += 1; freeByes += 1; }
                cur.pop(); used[j] = false;
                if (!exhausted) break;
            }
            used[pick] = false;
        }
        dfs(0);

        return {
            cost: best,
            pairs: bestPairs ? bestPairs.map(([i, j]) => [items[i], items[j]]) : null,
            proven: exhausted && bestPairs !== null,
        };
    }

    // -> { pairs: [[entry, entry|null]], clubClashes, proven, byesMoved }
    function bestRound1Pairing(seededEntries, bracketSize) {
        const byeCount = bracketSize - seededEntries.length;
        const clubCount = cost => Math.floor((cost + 1e-6) / CLUB_CLASH_COST);

        const byeHolders = seededEntries.slice(0, byeCount);
        const phase1 = solveMinClashPairing(seededEntries.slice(byeCount).map(e => ({ entry: e })), SEEDING_NODE_LIMIT);
        let best = {
            pairs: [...byeHolders.map(e => [e, null]), ...(phase1.pairs || []).map(([a, b]) => [a.entry, b.entry])],
            clubClashes: clubCount(phase1.cost),
            proven: clubCount(phase1.cost) === 0 || (byeCount === 0 && phase1.proven),
            byesMoved: false,
        };

        if (byeCount > 0 && best.clubClashes > 0) {
            const items = seededEntries.map((e, idx) => ({ entry: e, byeCost: idx * 1e-4 }));
            for (let k = 0; k < byeCount; k++) items.push({ bye: true });
            const phase2 = solveMinClashPairing(items, SEEDING_NODE_LIMIT);
            if (phase2.pairs && clubCount(phase2.cost) < best.clubClashes) {
                best = {
                    pairs: phase2.pairs.map(([a, b]) => a.bye ? [b.entry, null] : b.bye ? [a.entry, null] : [a.entry, b.entry]),
                    clubClashes: clubCount(phase2.cost),
                    proven: phase2.proven,
                    byesMoved: true,
                };
            } else {
                best.proven = phase2.proven;
            }
        }

        // Counting lower bound: a club with k entrants needs k outside
        // partners, so ceil((k - others - byes) / 2) clashes are forced.
        if (!best.proven) {
            const perClub = {};
            seededEntries.forEach(e => { if (e.clubId) perClub[e.clubId] = (perClub[e.clubId] || 0) + 1; });
            const forced = Object.values(perClub).reduce((mx, k) =>
                Math.max(mx, Math.ceil(Math.max(0, k - (seededEntries.length - k) - byeCount) / 2)), 0);
            if (best.clubClashes <= forced) best.proven = true;
        }
        return best;
    }

    function placePairsIntoBracket(pairs, bracketSize) {
        const order = standardSeedSlotOrder(bracketSize);
        const positions = [];
        for (let p = 0; p < bracketSize / 2; p++) positions.push({ p, key: Math.min(order[2 * p], order[2 * p + 1]) });
        positions.sort((a, b) => a.key - b.key);

        const seedOf = e => (e ? e.seed : Infinity);
        const normalized = pairs
            .map(([a, b]) => (seedOf(a) <= seedOf(b) ? [a, b] : [b, a]))
            .sort((x, y) => seedOf(x[0]) - seedOf(y[0]));

        const slots = new Array(bracketSize).fill(null);
        normalized.forEach((pair, k) => {
            const p = positions[k].p;
            slots[2 * p] = pair[0];
            slots[2 * p + 1] = pair[1];
        });
        return slots;
    }

    function annotateRound1(slots, pairing) {
        let club = 0, country = 0;
        for (let i = 0; i < slots.length; i += 2) {
            if (sameClub(slots[i], slots[i + 1])) club++;
            if (sameCountry(slots[i], slots[i + 1])) country++;
        }
        slots.conflictCount = club;
        slots.countryConflictCount = country;
        slots.minClubClashes = pairing.clubClashes;
        slots.minClashProven = pairing.proven;
        slots.byesMoved = pairing.byesMoved;
        return slots;
    }

    // "Standard": seed order only, but still computes the true minimum so
    // the hard-lock checker can flag avoidable same-club pairs.
    function placeStandardChecked(seededEntries, bracketSize) {
        return annotateRound1(placeStandard(seededEntries, bracketSize), bestRound1Pairing(seededEntries, bracketSize));
    }

    function placeClubSpread(seededEntries, bracketSize) {
        const pairing = bestRound1Pairing(seededEntries, bracketSize);
        return annotateRound1(placePairsIntoBracket(pairing.pairs, bracketSize), pairing);
    }

    // Registry — keys are what gets saved as `placementStrategy` on the
    // bracket doc, so never rename an existing key.
    const PLACEMENT_STRATEGIES = {
        standard: placeStandardChecked,
        club_country_spread: placeClubSpread,
    };

    // ── Single elimination tree ─────────────────────────────────────────
    // Match ids follow "{categoryCode}_r{round}_m{matchNumber}" — depends
    // only on structure, never on who sits in a slot, which is why a saved
    // `source.matchId` resolves against a freshly rebuilt tree.
    function generateSingleElimination(categoryCode, entries, placementFn) {
        placementFn = placementFn || PLACEMENT_STRATEGIES.standard;
        const bracketSize = nextPowerOfTwo(entries.length);
        const slots = placementFn(entries, bracketSize);

        const entrySlotIndex = {};
        slots.forEach((entry, idx) => { if (entry) entrySlotIndex[entry.entryId] = idx; });

        const rounds = [];
        let prevRoundMatches = null;
        let roundNum = 1;

        for (; ;) {
            const numMatches = roundNum === 1 ? bracketSize / 2 : prevRoundMatches.length / 2;
            if (numMatches < 1) break;

            const roundMatches = [];
            for (let i = 0; i < numMatches; i++) {
                const matchId = `${categoryCode}_r${roundNum}_m${i + 1}`;
                let blue, red, status, winnerCorner = null;

                if (roundNum === 1) {
                    const p1 = slots[i * 2], p2 = slots[i * 2 + 1];
                    blue = cornerFromEntry(p1);
                    red = cornerFromEntry(p2);
                    if (p1 && !p2) { status = "walkover"; winnerCorner = cornerFromEntry(p1); }
                    else if (p2 && !p1) { status = "walkover"; winnerCorner = cornerFromEntry(p2); }
                    else if (p1 && p2) status = "ready";
                    else status = "walkover";
                } else {
                    const m1 = prevRoundMatches[i * 2], m2 = prevRoundMatches[i * 2 + 1];
                    blue = m1.status === "walkover" ? m1.winnerCorner : { entryId: null, source: { matchId: m1.matchId, slot: "winner" } };
                    red = m2.status === "walkover" ? m2.winnerCorner : { entryId: null, source: { matchId: m2.matchId, slot: "winner" } };
                    status = (blue && blue.entryId && red && red.entryId) ? "ready" : "pending";
                }

                const playersEnteringRound = bracketSize / Math.pow(2, roundNum - 1);
                roundMatches.push({
                    matchId, categoryCode, round: roundNum, matchNumber: i + 1,
                    roundPhase: roundPhaseCode(playersEnteringRound),
                    blue, red, status, winnerEntryId: null,
                    winnerCorner, // internal only — walkovers are never pushed
                    courtId: null, queuePosition: null,
                });
            }

            rounds.push(roundMatches);
            if (roundMatches.length === 1) break;
            prevRoundMatches = roundMatches;
            roundNum++;
        }

        return {
            rounds, bracketSize, entrySlotIndex,
            conflictCount: slots.conflictCount || 0,
            minClubClashes: slots.minClubClashes ?? null,
            minClashProven: slots.minClashProven ?? null,
            byesMoved: !!slots.byesMoved,
        };
    }

    global.BracketCore = {
        nextPowerOfTwo, sameClub, sameCountry,
        roundPhaseCode, roundLabelText, cornerFromEntry,
        standardSeedSlotOrder, placeStandard, placeStandardChecked, placeClubSpread,
        bestRound1Pairing, PLACEMENT_STRATEGIES,
        generateSingleElimination,
    };
})(typeof window !== "undefined" ? window : globalThis);