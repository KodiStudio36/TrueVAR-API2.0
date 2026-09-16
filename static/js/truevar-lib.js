/**
 * TrueVAR shared client-side library.
 *
 * Single source of truth for two things that had drifted out of sync
 * across templates:
 *
 *   1. Country data (alpha-2, alpha-3, name). Previously duplicated three
 *      different ways: create_athlete.html hand-typed 67 countries,
 *      create_club.html hand-typed only 10, and tournament.html /
 *      category_manager.html each carried their own 249-entry
 *      alpha3->alpha2-only map with no names at all. This file carries
 *      the full ISO 3166-1 set (249 entries, generated from pycountry —
 *      the same library the backend's club_router.py already uses for
 *      country normalization) with alpha2 + alpha3 + name together, so
 *      every page draws from the same list.
 *
 *   2. WT belt/rank labels (rank 0-18). tournament.html and
 *      category_manager.html said "10. Keup"; club_roster.html said
 *      "10. GUP" for the exact same rank value. Normalized here to
 *      "10. GUP" ... "1. GUP", "1. DAN" ... "9. DAN".
 *
 * Usage: include this file with a plain <script> tag BEFORE a page's own
 * <script> block:
 *
 *   <script src="/static/js/truevar-lib.js"></script>
 *
 * (Adjust the path if your static files are mounted somewhere other than
 * /static — see wherever your app does app.mount("/static", ...).)
 *
 * It attaches a single global, `TrueVAR`, with no other dependencies —
 * safe to load on any page, in any order relative to other scripts, as
 * long as it comes before the code that calls it.
 */
(function (global) {
    "use strict";

    const COUNTRIES = [
        { alpha2: "AF", alpha3: "AFG", name: "Afghanistan" },
        { alpha2: "AL", alpha3: "ALB", name: "Albania" },
        { alpha2: "DZ", alpha3: "DZA", name: "Algeria" },
        { alpha2: "AS", alpha3: "ASM", name: "American Samoa" },
        { alpha2: "AD", alpha3: "AND", name: "Andorra" },
        { alpha2: "AO", alpha3: "AGO", name: "Angola" },
        { alpha2: "AI", alpha3: "AIA", name: "Anguilla" },
        { alpha2: "AQ", alpha3: "ATA", name: "Antarctica" },
        { alpha2: "AG", alpha3: "ATG", name: "Antigua and Barbuda" },
        { alpha2: "AR", alpha3: "ARG", name: "Argentina" },
        { alpha2: "AM", alpha3: "ARM", name: "Armenia" },
        { alpha2: "AW", alpha3: "ABW", name: "Aruba" },
        { alpha2: "AU", alpha3: "AUS", name: "Australia" },
        { alpha2: "AT", alpha3: "AUT", name: "Austria" },
        { alpha2: "AZ", alpha3: "AZE", name: "Azerbaijan" },
        { alpha2: "BS", alpha3: "BHS", name: "Bahamas" },
        { alpha2: "BH", alpha3: "BHR", name: "Bahrain" },
        { alpha2: "BD", alpha3: "BGD", name: "Bangladesh" },
        { alpha2: "BB", alpha3: "BRB", name: "Barbados" },
        { alpha2: "BY", alpha3: "BLR", name: "Belarus" },
        { alpha2: "BE", alpha3: "BEL", name: "Belgium" },
        { alpha2: "BZ", alpha3: "BLZ", name: "Belize" },
        { alpha2: "BJ", alpha3: "BEN", name: "Benin" },
        { alpha2: "BM", alpha3: "BMU", name: "Bermuda" },
        { alpha2: "BT", alpha3: "BTN", name: "Bhutan" },
        { alpha2: "BO", alpha3: "BOL", name: "Bolivia" },
        { alpha2: "BQ", alpha3: "BES", name: "Bonaire, Sint Eustatius and Saba" },
        { alpha2: "BA", alpha3: "BIH", name: "Bosnia and Herzegovina" },
        { alpha2: "BW", alpha3: "BWA", name: "Botswana" },
        { alpha2: "BV", alpha3: "BVT", name: "Bouvet Island" },
        { alpha2: "BR", alpha3: "BRA", name: "Brazil" },
        { alpha2: "IO", alpha3: "IOT", name: "British Indian Ocean Territory" },
        { alpha2: "BN", alpha3: "BRN", name: "Brunei Darussalam" },
        { alpha2: "BG", alpha3: "BGR", name: "Bulgaria" },
        { alpha2: "BF", alpha3: "BFA", name: "Burkina Faso" },
        { alpha2: "BI", alpha3: "BDI", name: "Burundi" },
        { alpha2: "CV", alpha3: "CPV", name: "Cabo Verde" },
        { alpha2: "KH", alpha3: "KHM", name: "Cambodia" },
        { alpha2: "CM", alpha3: "CMR", name: "Cameroon" },
        { alpha2: "CA", alpha3: "CAN", name: "Canada" },
        { alpha2: "KY", alpha3: "CYM", name: "Cayman Islands" },
        { alpha2: "CF", alpha3: "CAF", name: "Central African Republic" },
        { alpha2: "TD", alpha3: "TCD", name: "Chad" },
        { alpha2: "CL", alpha3: "CHL", name: "Chile" },
        { alpha2: "CN", alpha3: "CHN", name: "China" },
        { alpha2: "CX", alpha3: "CXR", name: "Christmas Island" },
        { alpha2: "CC", alpha3: "CCK", name: "Cocos (Keeling) Islands" },
        { alpha2: "CO", alpha3: "COL", name: "Colombia" },
        { alpha2: "KM", alpha3: "COM", name: "Comoros" },
        { alpha2: "CG", alpha3: "COG", name: "Congo" },
        { alpha2: "CD", alpha3: "COD", name: "Congo, The Democratic Republic of the" },
        { alpha2: "CK", alpha3: "COK", name: "Cook Islands" },
        { alpha2: "CR", alpha3: "CRI", name: "Costa Rica" },
        { alpha2: "HR", alpha3: "HRV", name: "Croatia" },
        { alpha2: "CU", alpha3: "CUB", name: "Cuba" },
        { alpha2: "CW", alpha3: "CUW", name: "Cura\u00e7ao" },
        { alpha2: "CY", alpha3: "CYP", name: "Cyprus" },
        { alpha2: "CZ", alpha3: "CZE", name: "Czechia" },
        { alpha2: "CI", alpha3: "CIV", name: "C\u00f4te d'Ivoire" },
        { alpha2: "DK", alpha3: "DNK", name: "Denmark" },
        { alpha2: "DJ", alpha3: "DJI", name: "Djibouti" },
        { alpha2: "DM", alpha3: "DMA", name: "Dominica" },
        { alpha2: "DO", alpha3: "DOM", name: "Dominican Republic" },
        { alpha2: "EC", alpha3: "ECU", name: "Ecuador" },
        { alpha2: "EG", alpha3: "EGY", name: "Egypt" },
        { alpha2: "SV", alpha3: "SLV", name: "El Salvador" },
        { alpha2: "GQ", alpha3: "GNQ", name: "Equatorial Guinea" },
        { alpha2: "ER", alpha3: "ERI", name: "Eritrea" },
        { alpha2: "EE", alpha3: "EST", name: "Estonia" },
        { alpha2: "SZ", alpha3: "SWZ", name: "Eswatini" },
        { alpha2: "ET", alpha3: "ETH", name: "Ethiopia" },
        { alpha2: "FK", alpha3: "FLK", name: "Falkland Islands (Malvinas)" },
        { alpha2: "FO", alpha3: "FRO", name: "Faroe Islands" },
        { alpha2: "FJ", alpha3: "FJI", name: "Fiji" },
        { alpha2: "FI", alpha3: "FIN", name: "Finland" },
        { alpha2: "FR", alpha3: "FRA", name: "France" },
        { alpha2: "GF", alpha3: "GUF", name: "French Guiana" },
        { alpha2: "PF", alpha3: "PYF", name: "French Polynesia" },
        { alpha2: "TF", alpha3: "ATF", name: "French Southern Territories" },
        { alpha2: "GA", alpha3: "GAB", name: "Gabon" },
        { alpha2: "GM", alpha3: "GMB", name: "Gambia" },
        { alpha2: "GE", alpha3: "GEO", name: "Georgia" },
        { alpha2: "DE", alpha3: "DEU", name: "Germany" },
        { alpha2: "GH", alpha3: "GHA", name: "Ghana" },
        { alpha2: "GI", alpha3: "GIB", name: "Gibraltar" },
        { alpha2: "GR", alpha3: "GRC", name: "Greece" },
        { alpha2: "GL", alpha3: "GRL", name: "Greenland" },
        { alpha2: "GD", alpha3: "GRD", name: "Grenada" },
        { alpha2: "GP", alpha3: "GLP", name: "Guadeloupe" },
        { alpha2: "GU", alpha3: "GUM", name: "Guam" },
        { alpha2: "GT", alpha3: "GTM", name: "Guatemala" },
        { alpha2: "GG", alpha3: "GGY", name: "Guernsey" },
        { alpha2: "GN", alpha3: "GIN", name: "Guinea" },
        { alpha2: "GW", alpha3: "GNB", name: "Guinea-Bissau" },
        { alpha2: "GY", alpha3: "GUY", name: "Guyana" },
        { alpha2: "HT", alpha3: "HTI", name: "Haiti" },
        { alpha2: "HM", alpha3: "HMD", name: "Heard Island and McDonald Islands" },
        { alpha2: "VA", alpha3: "VAT", name: "Holy See (Vatican City State)" },
        { alpha2: "HN", alpha3: "HND", name: "Honduras" },
        { alpha2: "HK", alpha3: "HKG", name: "Hong Kong" },
        { alpha2: "HU", alpha3: "HUN", name: "Hungary" },
        { alpha2: "IS", alpha3: "ISL", name: "Iceland" },
        { alpha2: "IN", alpha3: "IND", name: "India" },
        { alpha2: "ID", alpha3: "IDN", name: "Indonesia" },
        { alpha2: "IR", alpha3: "IRN", name: "Iran" },
        { alpha2: "IQ", alpha3: "IRQ", name: "Iraq" },
        { alpha2: "IE", alpha3: "IRL", name: "Ireland" },
        { alpha2: "IM", alpha3: "IMN", name: "Isle of Man" },
        { alpha2: "IL", alpha3: "ISR", name: "Israel" },
        { alpha2: "IT", alpha3: "ITA", name: "Italy" },
        { alpha2: "JM", alpha3: "JAM", name: "Jamaica" },
        { alpha2: "JP", alpha3: "JPN", name: "Japan" },
        { alpha2: "JE", alpha3: "JEY", name: "Jersey" },
        { alpha2: "JO", alpha3: "JOR", name: "Jordan" },
        { alpha2: "KZ", alpha3: "KAZ", name: "Kazakhstan" },
        { alpha2: "KE", alpha3: "KEN", name: "Kenya" },
        { alpha2: "KI", alpha3: "KIR", name: "Kiribati" },
        { alpha2: "KW", alpha3: "KWT", name: "Kuwait" },
        { alpha2: "KG", alpha3: "KGZ", name: "Kyrgyzstan" },
        { alpha2: "LA", alpha3: "LAO", name: "Laos" },
        { alpha2: "LV", alpha3: "LVA", name: "Latvia" },
        { alpha2: "LB", alpha3: "LBN", name: "Lebanon" },
        { alpha2: "LS", alpha3: "LSO", name: "Lesotho" },
        { alpha2: "LR", alpha3: "LBR", name: "Liberia" },
        { alpha2: "LY", alpha3: "LBY", name: "Libya" },
        { alpha2: "LI", alpha3: "LIE", name: "Liechtenstein" },
        { alpha2: "LT", alpha3: "LTU", name: "Lithuania" },
        { alpha2: "LU", alpha3: "LUX", name: "Luxembourg" },
        { alpha2: "MO", alpha3: "MAC", name: "Macao" },
        { alpha2: "MG", alpha3: "MDG", name: "Madagascar" },
        { alpha2: "MW", alpha3: "MWI", name: "Malawi" },
        { alpha2: "MY", alpha3: "MYS", name: "Malaysia" },
        { alpha2: "MV", alpha3: "MDV", name: "Maldives" },
        { alpha2: "ML", alpha3: "MLI", name: "Mali" },
        { alpha2: "MT", alpha3: "MLT", name: "Malta" },
        { alpha2: "MH", alpha3: "MHL", name: "Marshall Islands" },
        { alpha2: "MQ", alpha3: "MTQ", name: "Martinique" },
        { alpha2: "MR", alpha3: "MRT", name: "Mauritania" },
        { alpha2: "MU", alpha3: "MUS", name: "Mauritius" },
        { alpha2: "YT", alpha3: "MYT", name: "Mayotte" },
        { alpha2: "MX", alpha3: "MEX", name: "Mexico" },
        { alpha2: "FM", alpha3: "FSM", name: "Micronesia, Federated States of" },
        { alpha2: "MD", alpha3: "MDA", name: "Moldova" },
        { alpha2: "MC", alpha3: "MCO", name: "Monaco" },
        { alpha2: "MN", alpha3: "MNG", name: "Mongolia" },
        { alpha2: "ME", alpha3: "MNE", name: "Montenegro" },
        { alpha2: "MS", alpha3: "MSR", name: "Montserrat" },
        { alpha2: "MA", alpha3: "MAR", name: "Morocco" },
        { alpha2: "MZ", alpha3: "MOZ", name: "Mozambique" },
        { alpha2: "MM", alpha3: "MMR", name: "Myanmar" },
        { alpha2: "NA", alpha3: "NAM", name: "Namibia" },
        { alpha2: "NR", alpha3: "NRU", name: "Nauru" },
        { alpha2: "NP", alpha3: "NPL", name: "Nepal" },
        { alpha2: "NL", alpha3: "NLD", name: "Netherlands" },
        { alpha2: "NC", alpha3: "NCL", name: "New Caledonia" },
        { alpha2: "NZ", alpha3: "NZL", name: "New Zealand" },
        { alpha2: "NI", alpha3: "NIC", name: "Nicaragua" },
        { alpha2: "NE", alpha3: "NER", name: "Niger" },
        { alpha2: "NG", alpha3: "NGA", name: "Nigeria" },
        { alpha2: "NU", alpha3: "NIU", name: "Niue" },
        { alpha2: "NF", alpha3: "NFK", name: "Norfolk Island" },
        { alpha2: "KP", alpha3: "PRK", name: "North Korea" },
        { alpha2: "MK", alpha3: "MKD", name: "North Macedonia" },
        { alpha2: "MP", alpha3: "MNP", name: "Northern Mariana Islands" },
        { alpha2: "NO", alpha3: "NOR", name: "Norway" },
        { alpha2: "OM", alpha3: "OMN", name: "Oman" },
        { alpha2: "PK", alpha3: "PAK", name: "Pakistan" },
        { alpha2: "PW", alpha3: "PLW", name: "Palau" },
        { alpha2: "PS", alpha3: "PSE", name: "Palestine, State of" },
        { alpha2: "PA", alpha3: "PAN", name: "Panama" },
        { alpha2: "PG", alpha3: "PNG", name: "Papua New Guinea" },
        { alpha2: "PY", alpha3: "PRY", name: "Paraguay" },
        { alpha2: "PE", alpha3: "PER", name: "Peru" },
        { alpha2: "PH", alpha3: "PHL", name: "Philippines" },
        { alpha2: "PN", alpha3: "PCN", name: "Pitcairn" },
        { alpha2: "PL", alpha3: "POL", name: "Poland" },
        { alpha2: "PT", alpha3: "PRT", name: "Portugal" },
        { alpha2: "PR", alpha3: "PRI", name: "Puerto Rico" },
        { alpha2: "QA", alpha3: "QAT", name: "Qatar" },
        { alpha2: "RO", alpha3: "ROU", name: "Romania" },
        { alpha2: "RU", alpha3: "RUS", name: "Russian Federation" },
        { alpha2: "RW", alpha3: "RWA", name: "Rwanda" },
        { alpha2: "RE", alpha3: "REU", name: "R\u00e9union" },
        { alpha2: "BL", alpha3: "BLM", name: "Saint Barth\u00e9lemy" },
        { alpha2: "SH", alpha3: "SHN", name: "Saint Helena, Ascension and Tristan da Cunha" },
        { alpha2: "KN", alpha3: "KNA", name: "Saint Kitts and Nevis" },
        { alpha2: "LC", alpha3: "LCA", name: "Saint Lucia" },
        { alpha2: "MF", alpha3: "MAF", name: "Saint Martin (French part)" },
        { alpha2: "PM", alpha3: "SPM", name: "Saint Pierre and Miquelon" },
        { alpha2: "VC", alpha3: "VCT", name: "Saint Vincent and the Grenadines" },
        { alpha2: "WS", alpha3: "WSM", name: "Samoa" },
        { alpha2: "SM", alpha3: "SMR", name: "San Marino" },
        { alpha2: "ST", alpha3: "STP", name: "Sao Tome and Principe" },
        { alpha2: "SA", alpha3: "SAU", name: "Saudi Arabia" },
        { alpha2: "SN", alpha3: "SEN", name: "Senegal" },
        { alpha2: "RS", alpha3: "SRB", name: "Serbia" },
        { alpha2: "SC", alpha3: "SYC", name: "Seychelles" },
        { alpha2: "SL", alpha3: "SLE", name: "Sierra Leone" },
        { alpha2: "SG", alpha3: "SGP", name: "Singapore" },
        { alpha2: "SX", alpha3: "SXM", name: "Sint Maarten (Dutch part)" },
        { alpha2: "SK", alpha3: "SVK", name: "Slovakia" },
        { alpha2: "SI", alpha3: "SVN", name: "Slovenia" },
        { alpha2: "SB", alpha3: "SLB", name: "Solomon Islands" },
        { alpha2: "SO", alpha3: "SOM", name: "Somalia" },
        { alpha2: "ZA", alpha3: "ZAF", name: "South Africa" },
        { alpha2: "GS", alpha3: "SGS", name: "South Georgia and the South Sandwich Islands" },
        { alpha2: "KR", alpha3: "KOR", name: "South Korea" },
        { alpha2: "SS", alpha3: "SSD", name: "South Sudan" },
        { alpha2: "ES", alpha3: "ESP", name: "Spain" },
        { alpha2: "LK", alpha3: "LKA", name: "Sri Lanka" },
        { alpha2: "SD", alpha3: "SDN", name: "Sudan" },
        { alpha2: "SR", alpha3: "SUR", name: "Suriname" },
        { alpha2: "SJ", alpha3: "SJM", name: "Svalbard and Jan Mayen" },
        { alpha2: "SE", alpha3: "SWE", name: "Sweden" },
        { alpha2: "CH", alpha3: "CHE", name: "Switzerland" },
        { alpha2: "SY", alpha3: "SYR", name: "Syria" },
        { alpha2: "TW", alpha3: "TWN", name: "Taiwan" },
        { alpha2: "TJ", alpha3: "TJK", name: "Tajikistan" },
        { alpha2: "TZ", alpha3: "TZA", name: "Tanzania" },
        { alpha2: "TH", alpha3: "THA", name: "Thailand" },
        { alpha2: "TL", alpha3: "TLS", name: "Timor-Leste" },
        { alpha2: "TG", alpha3: "TGO", name: "Togo" },
        { alpha2: "TK", alpha3: "TKL", name: "Tokelau" },
        { alpha2: "TO", alpha3: "TON", name: "Tonga" },
        { alpha2: "TT", alpha3: "TTO", name: "Trinidad and Tobago" },
        { alpha2: "TN", alpha3: "TUN", name: "Tunisia" },
        { alpha2: "TM", alpha3: "TKM", name: "Turkmenistan" },
        { alpha2: "TC", alpha3: "TCA", name: "Turks and Caicos Islands" },
        { alpha2: "TV", alpha3: "TUV", name: "Tuvalu" },
        { alpha2: "TR", alpha3: "TUR", name: "T\u00fcrkiye" },
        { alpha2: "UG", alpha3: "UGA", name: "Uganda" },
        { alpha2: "UA", alpha3: "UKR", name: "Ukraine" },
        { alpha2: "AE", alpha3: "ARE", name: "United Arab Emirates" },
        { alpha2: "GB", alpha3: "GBR", name: "United Kingdom" },
        { alpha2: "US", alpha3: "USA", name: "United States" },
        { alpha2: "UM", alpha3: "UMI", name: "United States Minor Outlying Islands" },
        { alpha2: "UY", alpha3: "URY", name: "Uruguay" },
        { alpha2: "UZ", alpha3: "UZB", name: "Uzbekistan" },
        { alpha2: "VU", alpha3: "VUT", name: "Vanuatu" },
        { alpha2: "VE", alpha3: "VEN", name: "Venezuela" },
        { alpha2: "VN", alpha3: "VNM", name: "Vietnam" },
        { alpha2: "VG", alpha3: "VGB", name: "Virgin Islands, British" },
        { alpha2: "VI", alpha3: "VIR", name: "Virgin Islands, U.S." },
        { alpha2: "WF", alpha3: "WLF", name: "Wallis and Futuna" },
        { alpha2: "EH", alpha3: "ESH", name: "Western Sahara" },
        { alpha2: "YE", alpha3: "YEM", name: "Yemen" },
        { alpha2: "ZM", alpha3: "ZMB", name: "Zambia" },
        { alpha2: "ZW", alpha3: "ZWE", name: "Zimbabwe" },
        { alpha2: "AX", alpha3: "ALA", name: "\u00c5land Islands" },
    ];

    // ── Lookup indexes, built once ────────────────────────────────────
    const ALPHA3_TO_ALPHA2 = {};
    const ALPHA2_TO_ALPHA3 = {};
    const ALPHA3_TO_NAME = {};
    COUNTRIES.forEach((c) => {
        ALPHA3_TO_ALPHA2[c.alpha3] = c.alpha2;
        ALPHA2_TO_ALPHA3[c.alpha2] = c.alpha3;
        ALPHA3_TO_NAME[c.alpha3] = c.name;
    });

    const SORTED_COUNTRIES = COUNTRIES.slice().sort((a, b) => a.name.localeCompare(b.name));

    function toAlpha2(alpha3) {
        return ALPHA3_TO_ALPHA2[(alpha3 || "").toUpperCase()] || null;
    }

    function toAlpha3(alpha2) {
        return ALPHA2_TO_ALPHA3[(alpha2 || "").toUpperCase()] || null;
    }

    function countryName(alpha3) {
        return ALPHA3_TO_NAME[(alpha3 || "").toUpperCase()] || null;
    }

    // Accepts either an alpha-2 or alpha-3 code — every call site in the
    // codebase so far only ever has alpha-3 on hand (that's what athlete
    // docs store), but accepting alpha-2 too costs nothing and avoids a
    // second helper.
    function flagEmoji(code) {
        const c = (code || "").toUpperCase();
        const alpha2 = c.length === 2 ? c : toAlpha2(c);
        if (!alpha2 || alpha2.length !== 2) return "";
        return String.fromCodePoint(...[...alpha2].map((ch) => 127397 + ch.charCodeAt(0)));
    }

    function sortedCountries() {
        return SORTED_COUNTRIES;
    }

    // Populates a <select> with one <option> per country, value=alpha3,
    // label="Name (ALPHA3)" — matches create_athlete.html's original
    // format exactly. Pass `selected` to preselect a country (e.g. the
    // admin's club country); pass `includeBlank: false` to skip the
    // leading disabled placeholder option (a page can render its own
    // instead, as create_athlete.html's markup already does).
    function populateCountrySelect(selectEl, opts) {
        opts = opts || {};
        if (!selectEl) return;
        if (opts.includeBlank !== false && selectEl.querySelector('option[value=""]') === null) {
            const blank = document.createElement("option");
            blank.value = "";
            blank.disabled = true;
            blank.selected = true;
            blank.textContent = opts.blankLabel || "Select country...";
            selectEl.appendChild(blank);
        }
        sortedCountries().forEach((c) => {
            const opt = document.createElement("option");
            opt.value = c.alpha3;
            opt.textContent = `${c.name} (${c.alpha3})`;
            selectEl.appendChild(opt);
        });
        if (opts.selected) {
            selectEl.value = opts.selected.toUpperCase();
        }
    }

    // ── WT belt / rank (0-18) ──────────────────────────────────────────
    // rank 0-9  -> color belts, "10. GUP" down to "1. GUP"
    // rank 10-18 -> black belts, "1. DAN" up to "9. DAN"
    const BELT_LABELS = [
        "10. GUP", "9. GUP", "8. GUP", "7. GUP", "6. GUP",
        "5. GUP", "4. GUP", "3. GUP", "2. GUP", "1. GUP",
        "1. DAN", "2. DAN", "3. DAN", "4. DAN", "5. DAN",
        "6. DAN", "7. DAN", "8. DAN", "9. DAN",
    ];

    // Slightly fuller labels for pickers where the old/new-comer-facing
    // color name is useful context (mirrors create_athlete.html's
    // pre-existing tkd_rank <option> text, just with GUP instead of Keup).
    const BELT_COLOR_NAMES = [
        "White", "White-Yellow", "Yellow", "Yellow-Green", "Green",
        "Green-Blue", "Blue", "Blue-Red", "Red", "Red-Black",
    ];

    function beltLabel(rank) {
        if (rank === undefined || rank === null || rank === "") return null;
        const r = Number(rank);
        if (!Number.isInteger(r) || r < 0 || r >= BELT_LABELS.length) return null;
        return BELT_LABELS[r];
    }

    // Populates a <select> with one <option value="0".."18"> per rank,
    // using the same normalized "N. GUP" / "N. DAN" text as beltLabel(),
    // grouped into Color Belts / Black Belts optgroups like
    // create_athlete.html's original static markup.
    function populateBeltSelect(selectEl, opts) {
        opts = opts || {};
        if (!selectEl) return;
        if (opts.includeBlank) {
            const blank = document.createElement("option");
            blank.value = "";
            blank.disabled = true;
            blank.selected = true;
            blank.textContent = opts.blankLabel || "Select rank...";
            selectEl.appendChild(blank);
        }

        const colorGroup = document.createElement("optgroup");
        colorGroup.label = "Color Belts (Gup)";
        for (let r = 0; r <= 9; r++) {
            const opt = document.createElement("option");
            opt.value = String(r);
            opt.textContent = `${BELT_LABELS[r]} (${BELT_COLOR_NAMES[r]})`;
            colorGroup.appendChild(opt);
        }
        selectEl.appendChild(colorGroup);

        const blackGroup = document.createElement("optgroup");
        blackGroup.label = "Black Belts (Dan/Poom)";
        for (let r = 10; r <= 18; r++) {
            const opt = document.createElement("option");
            opt.value = String(r);
            opt.textContent = BELT_LABELS[r];
            blackGroup.appendChild(opt);
        }
        selectEl.appendChild(blackGroup);

        if (opts.selected !== undefined && opts.selected !== null) {
            selectEl.value = String(opts.selected);
        }
    }

    // ── UTC-as-local convention for <input type="datetime-local"> ──────
    // Every date/time this app stores (tournament dateTime, registration
    // deadline) is a real UTC instant, and every server-rendered form
    // field is filled with that instant's raw UTC digits with NO
    // conversion (e.g. tournament_detail.html's edit form does
    // tournament.dateTime.strftime('%Y-%m-%dT%H:%M')). A <input
    // type="datetime-local"> has no timezone concept of its own — the
    // moment you hand its value to `new Date(...)`, the browser silently
    // reinterprets those digits as ITS OWN local time zone. Mixing
    // "digits are UTC" (how the form is filled) with "digits are local"
    // (how `new Date(...).toISOString()` reads them back on submit) is
    // exactly what caused tournament times to drift by the editor's UTC
    // offset on every single save — even without touching the date
    // field. These two helpers make the convention explicit and
    // SYMMETRIC: a datetime-local's digits are always UTC, both when
    // building the ISO string to send to the server and when converting
    // a server value back into the input, regardless of the browser's
    // actual time zone. Use utcInputToIso() wherever a form currently
    // does `new Date(input.value).toISOString()`, and isoToUtcInput()
    // anywhere a value needs to be pushed into a datetime-local field
    // from JS (Jinja-rendered strftime values need no conversion — they
    // already print raw UTC digits, which already matches this
    // convention).
    function utcInputToIso(value) {
        if (!value) return null;
        // "2026-09-19T07:00" (no seconds) or "2026-09-19T07:00:00" -> always
        // pad to a full ISO instant with an explicit "Z" so this is parsed
        // as UTC everywhere it's sent (Date, Pydantic, JSON.parse, etc.) —
        // never left ambiguous for a second interpreter to reinterpret.
        const withSeconds = value.length === 16 ? `${value}:00` : value;
        return `${withSeconds}.000Z`;
    }

    function isoToUtcInput(isoOrDate) {
        if (!isoOrDate) return "";
        const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
        if (Number.isNaN(d.getTime())) return "";
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }

    global.TrueVAR = {
        COUNTRIES,
        toAlpha2,
        toAlpha3,
        countryName,
        flagEmoji,
        sortedCountries,
        populateCountrySelect,
        BELT_LABELS,
        beltLabel,
        populateBeltSelect,
        utcInputToIso,
        isoToUtcInput,
    };
})(window);