// Year in footer
document.getElementById('year').textContent = new Date().getFullYear();

// -------------------------------------------------------------------
// Live FHIR R4 sandbox (SMART Health IT — public, CORS-enabled, Synthea data)
// -------------------------------------------------------------------
const FHIR_BASE = "https://r4.smarthealthit.org";
const SAMPLE_COUNT = 6;

// -------------------------------------------------------------------
// Fetch helpers
// -------------------------------------------------------------------

async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} · ${url.replace(FHIR_BASE, "")}`);
    return resp.json();
}

async function fetchPatientList() {
    const bundle = await fetchJson(`${FHIR_BASE}/Patient?_count=${SAMPLE_COUNT}&_sort=-_lastUpdated`);
    return (bundle.entry || []).map((e) => e.resource).filter(Boolean);
}

async function fetchFhirPatient(id) {
    return fetchJson(`${FHIR_BASE}/Patient/${encodeURIComponent(id)}`);
}

function patientDisplayName(patient) {
    const nm = patient.name?.[0];
    if (!nm) return patient.id;
    const given = (nm.given || []).join(" ");
    return `${given} ${nm.family || ""}`.trim() || patient.id;
}

// -------------------------------------------------------------------
// ECW legacy envelope (simulated from a real FHIR patient)
// Shape mirrors eClinicalWorks' legacy EMR Web / EBO API (non-FHIR).
// -------------------------------------------------------------------
function synthesizeEcwEnvelope(fhir) {
    const nm = fhir.name?.[0] || {};
    const phone = (fhir.telecom || []).find((t) => t.system === "phone");
    const mobile = (fhir.telecom || []).find((t) => t.system === "phone" && t.use === "mobile");
    const email = (fhir.telecom || []).find((t) => t.system === "email");
    const addr = fhir.address?.[0] || {};
    const genderMap = { female: "Female", male: "Male", other: "Other", unknown: "Unknown" };
    const maritalExt = (fhir.extension || []).find((e) =>
        (e.url || "").toLowerCase().includes("marital")
    );
    return {
        Response: {
            ResponseCode: "0",
            ResponseMessage: "Success",
            ServerDateTime: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
            PatientInfo: [
                {
                    PatientID: fhir.id,
                    AccountNumber: `AC-${(fhir.id || "").slice(0, 8).toUpperCase()}`,
                    FirstName: nm.given?.[0] || "",
                    MiddleName: nm.given?.[1] || "",
                    LastName: nm.family || "",
                    DateOfBirth: fhir.birthDate ? `${fhir.birthDate}T00:00:00` : null,
                    Gender: genderMap[fhir.gender] || "Unknown",
                    MaritalStatus: maritalExt?.valueCodeableConcept?.text || "Unknown",
                    HomeAddress: {
                        Address1: addr.line?.[0] || "",
                        Address2: addr.line?.[1] || "",
                        City: addr.city || "",
                        State: addr.state || "",
                        Zip: addr.postalCode || "",
                        Country: addr.country || "USA",
                    },
                    HomePhone: phone?.value || "",
                    MobilePhone: mobile?.value || phone?.value || "",
                    EmailID: email?.value || "",
                    PCPName: fhir.generalPractitioner?.[0]?.display || "",
                    PreferredLanguage: "English",
                    LastVisitDate: null,
                },
            ],
        },
    };
}

// -------------------------------------------------------------------
// Per-resource definitions: endpoint, raw-hint, and normalizer.
// Each normalizer returns a compact, client-friendly shape.
// -------------------------------------------------------------------
const RESOURCES = {
    patient: {
        label: "Patient",
        rawHint: "Live · FHIR R4",
        // Patient is special: Epic live vs ECW simulated toggle lives here
        showEhrToggle: true,
    },
    conditions: {
        label: "Conditions",
        rawHint: "Live · FHIR R4 Bundle",
        endpoint: (pid) =>
            `${FHIR_BASE}/Condition?patient=${encodeURIComponent(pid)}&_count=15&_sort=-onset-date`,
        normalize(bundle) {
            return (bundle.entry || []).map((e) => {
                const r = e.resource || {};
                return {
                    id: r.id,
                    display:
                        r.code?.text ||
                        r.code?.coding?.[0]?.display ||
                        r.code?.coding?.[0]?.code ||
                        "Unknown",
                    code: r.code?.coding?.[0]?.code || null,
                    code_system: r.code?.coding?.[0]?.system || null,
                    clinical_status: r.clinicalStatus?.coding?.[0]?.code || null,
                    verification_status: r.verificationStatus?.coding?.[0]?.code || null,
                    onset_date:
                        r.onsetDateTime ||
                        r.onsetPeriod?.start ||
                        r.recordedDate ||
                        null,
                };
            });
        },
    },
    medications: {
        label: "Medications",
        rawHint: "Live · FHIR R4 Bundle",
        endpoint: (pid) =>
            `${FHIR_BASE}/MedicationRequest?patient=${encodeURIComponent(pid)}&_count=15&_sort=-authoredon`,
        normalize(bundle) {
            return (bundle.entry || []).map((e) => {
                const r = e.resource || {};
                const med =
                    r.medicationCodeableConcept?.text ||
                    r.medicationCodeableConcept?.coding?.[0]?.display ||
                    r.medicationReference?.display ||
                    "Unknown";
                const dosage = r.dosageInstruction?.[0]?.text || null;
                return {
                    id: r.id,
                    medication: med,
                    status: r.status || null,
                    intent: r.intent || null,
                    authored_on: r.authoredOn || null,
                    dosage,
                };
            });
        },
    },
    vitals: {
        label: "Vitals",
        rawHint: "Live · FHIR R4 Bundle",
        endpoint: (pid) =>
            `${FHIR_BASE}/Observation?category=vital-signs&patient=${encodeURIComponent(pid)}&_count=15&_sort=-date`,
        normalize(bundle) {
            return (bundle.entry || []).map((e) => {
                const r = e.resource || {};
                const display =
                    r.code?.text ||
                    r.code?.coding?.[0]?.display ||
                    r.code?.coding?.[0]?.code ||
                    "Observation";
                let value = null;
                let unit = null;
                if (r.valueQuantity) {
                    value = r.valueQuantity.value;
                    unit = r.valueQuantity.unit || r.valueQuantity.code || null;
                } else if (r.component?.length) {
                    value = r.component
                        .map((c) => {
                            const v = c.valueQuantity?.value;
                            const u = c.valueQuantity?.unit || c.valueQuantity?.code || "";
                            const label = c.code?.coding?.[0]?.display || c.code?.text || "";
                            return `${label ? label + ": " : ""}${v ?? "?"}${u ? " " + u : ""}`;
                        })
                        .join(" · ");
                }
                return {
                    id: r.id,
                    display,
                    code: r.code?.coding?.[0]?.code || null,
                    value,
                    unit,
                    effective: r.effectiveDateTime || r.effectivePeriod?.start || null,
                    status: r.status || null,
                };
            });
        },
    },
};

// Patient-tab transformers (Epic vs ECW → same normalized shape)
const PATIENT_TRANSFORMERS = {
    ecw(raw) {
        const p = raw.Response?.PatientInfo?.[0] || {};
        const dob = p.DateOfBirth ? p.DateOfBirth.split("T")[0] : null;
        return {
            patient_id: p.PatientID || null,
            name: {
                first: p.FirstName || null,
                middle: p.MiddleName || null,
                last: p.LastName || null,
            },
            date_of_birth: dob,
            gender: p.Gender === "Female" ? "female" : p.Gender === "Male" ? "male" : "unknown",
            contact: {
                phone: p.HomePhone || p.MobilePhone || null,
                email: p.EmailID || null,
            },
            address: {
                line1: p.HomeAddress?.Address1 || null,
                city: p.HomeAddress?.City || null,
                state: p.HomeAddress?.State || null,
                postal_code: p.HomeAddress?.Zip || null,
                country: p.HomeAddress?.Country === "USA" ? "US" : (p.HomeAddress?.Country || "US"),
            },
            primary_provider: p.PCPName || null,
            last_encounter_date: p.LastVisitDate || null,
            source_ehr: "eclinicalworks",
        };
    },
    epic(raw) {
        const nm = raw.name?.[0] || {};
        const phone = (raw.telecom || []).find((t) => t.system === "phone");
        const email = (raw.telecom || []).find((t) => t.system === "email");
        const addr = raw.address?.[0] || {};
        return {
            patient_id: raw.id,
            name: {
                first: nm.given?.[0] || null,
                middle: nm.given?.[1] || null,
                last: nm.family || null,
            },
            date_of_birth: raw.birthDate || null,
            gender: raw.gender || "unknown",
            contact: {
                phone: phone?.value || null,
                email: email?.value || null,
            },
            address: {
                line1: addr.line?.[0] || null,
                city: addr.city || null,
                state: addr.state || null,
                postal_code: addr.postalCode || null,
                country: addr.country || "US",
            },
            primary_provider: raw.generalPractitioner?.[0]?.display || null,
            last_encounter_date: null,
            source_ehr: "epic",
        };
    },
};

// -------------------------------------------------------------------
// Rendering helpers
// -------------------------------------------------------------------

function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightJson(obj) {
    const raw = escapeHtml(JSON.stringify(obj, null, 2));
    return raw.replace(
        /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g,
        (match) => {
            let cls = "j-number";
            if (/^"/.test(match)) {
                cls = /:$/.test(match) ? "j-key" : "j-string";
            } else if (/true|false/.test(match)) {
                cls = "j-bool";
            } else if (/null/.test(match)) {
                cls = "j-null";
            }
            return `<span class="${cls}">${match}</span>`;
        }
    );
}

// -------------------------------------------------------------------
// State & DOM
// -------------------------------------------------------------------
const $ehr = document.getElementById("ehr-select");
const $ehrCtl = document.getElementById("ehr-control");
const $pid = document.getElementById("patient-id");
const $btn = document.getElementById("fetch-btn");
const $req = document.getElementById("request-preview");
const $raw = document.getElementById("raw-response");
const $norm = document.getElementById("normalized-response");
const $rawHint = document.getElementById("raw-hint");
const $status = document.getElementById("status");
const $tabs = document.querySelectorAll(".demo-tab");

let activeTab = "patient";
let currentPatient = null; // cached FHIR Patient resource

function setStatus(msg, kind = "") {
    $status.textContent = msg;
    $status.className = "demo-status" + (kind ? " " + kind : "");
}

function updateRequestPreview() {
    const pid = $pid.value || "—";
    if (activeTab === "patient") {
        const ehr = $ehr.value;
        if (ehr === "epic") {
            $req.textContent = `GET ${FHIR_BASE}/Patient/${pid}`;
            $rawHint.textContent = RESOURCES.patient.rawHint;
        } else {
            $req.textContent = `GET /api/v1/clinical-summary/patient?ehr=ecw&patient_id=${pid}`;
            $rawHint.textContent = "Simulated · ECW envelope";
        }
        $btn.textContent = "Fetch patient";
    } else {
        const endpoint = RESOURCES[activeTab].endpoint(pid);
        $req.textContent = `GET ${endpoint}`;
        $rawHint.textContent = RESOURCES[activeTab].rawHint;
        $btn.textContent = `Fetch ${RESOURCES[activeTab].label.toLowerCase()}`;
    }
}

function setTab(tab) {
    activeTab = tab;
    $tabs.forEach((el) => {
        const on = el.dataset.tab === tab;
        el.classList.toggle("is-active", on);
        el.setAttribute("aria-selected", on ? "true" : "false");
    });
    // Only Patient tab uses the EHR toggle
    $ehrCtl.hidden = !RESOURCES[tab].showEhrToggle;
    updateRequestPreview();
    fetchActive();
}

async function populatePatientDropdown() {
    setStatus("Loading sample patients from SMART Health IT sandbox…");
    try {
        const patients = await fetchPatientList();
        if (!patients.length) throw new Error("no patients returned");
        $pid.innerHTML = "";
        for (const p of patients) {
            const opt = document.createElement("option");
            opt.value = p.id;
            opt.textContent = `${patientDisplayName(p)}  ·  ${p.id.slice(0, 8)}…`;
            $pid.appendChild(opt);
        }
        $btn.disabled = false;
        setStatus("Ready. Switch tabs to see Conditions / Medications / Vitals for this patient.", "ok");
        updateRequestPreview();
        fetchActive();
    } catch (err) {
        setStatus(`Couldn't load patient list: ${err.message}`, "err");
    }
}

async function fetchActive() {
    const pid = $pid.value;
    if (!pid) return;
    $btn.disabled = true;
    try {
        if (activeTab === "patient") {
            await fetchPatientTab(pid);
        } else {
            await fetchResourceTab(activeTab, pid);
        }
    } catch (err) {
        setStatus(`Error: ${err.message}`, "err");
        $raw.textContent = "—";
        $norm.textContent = "—";
    } finally {
        $btn.disabled = false;
    }
}

function byteSize(obj) {
    return new Blob([JSON.stringify(obj)]).size;
}

async function fetchPatientTab(pid) {
    const ehr = $ehr.value;
    setStatus(ehr === "epic" ? "Calling SMART Health IT FHIR sandbox…" : "Synthesizing ECW envelope…");
    clearMetrics();

    let fetchMs = 0;
    if (!currentPatient || currentPatient.id !== pid) {
        const t = await timedFetch(`${FHIR_BASE}/Patient/${encodeURIComponent(pid)}`);
        currentPatient = t.json;
        fetchMs = t.ms;
    }

    let rawResponse, key;
    if (ehr === "epic") {
        rawResponse = currentPatient;
        key = "epic";
    } else {
        rawResponse = synthesizeEcwEnvelope(currentPatient);
        key = "ecw";
    }

    const t0 = performance.now();
    const normalized = PATIENT_TRANSFORMERS[key](rawResponse);
    const transformMs = performance.now() - t0;

    $raw.innerHTML = highlightJson(rawResponse);
    $norm.innerHTML = highlightJson(normalized);
    showMetric($rawMetric, ehr === "epic" ? (fetchMs || 0) : transformMs, byteSize(rawResponse));
    showMetric($normMetric, transformMs, byteSize(normalized));

    const tag = ehr === "epic" ? "live FHIR R4" : "simulated ECW";
    setStatus(`200 OK · ${tag} · normalized via ${key.toUpperCase()} transformer`, "ok");
}

async function fetchResourceTab(tab, pid) {
    setStatus(`Calling SMART Health IT sandbox for ${tab}…`);
    clearMetrics();
    const t = await timedFetch(RESOURCES[tab].endpoint(pid));
    const bundle = t.json;

    const t0 = performance.now();
    const normalized = RESOURCES[tab].normalize(bundle);
    const transformMs = performance.now() - t0;

    $raw.innerHTML = highlightJson(bundle);
    $norm.innerHTML = highlightJson(normalized);
    showMetric($rawMetric, t.ms, t.bytes);
    showMetric($normMetric, transformMs, byteSize(normalized));

    const count = normalized.length;
    setStatus(`200 OK · live FHIR R4 · ${count} ${count === 1 ? "record" : "records"} normalized`, "ok");
}

// -------------------------------------------------------------------
// Events
// -------------------------------------------------------------------
$ehr.addEventListener("change", () => {
    updateRequestPreview();
    fetchActive();
});
$pid.addEventListener("change", () => {
    currentPatient = null;
    updateRequestPreview();
    fetchActive();
});
$btn.addEventListener("click", fetchActive);
$tabs.forEach((el) => {
    el.addEventListener("click", () => setTab(el.dataset.tab));
});

// -------------------------------------------------------------------
// Latency / payload chip
// -------------------------------------------------------------------
const $rawMetric = document.getElementById("raw-metric");
const $normMetric = document.getElementById("norm-metric");

function showMetric(el, ms, bytes) {
    if (!el) return;
    el.hidden = false;
    const kb = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
    el.textContent = `${Math.round(ms)} ms · ${kb}`;
}
function clearMetrics() {
    if ($rawMetric) $rawMetric.hidden = true;
    if ($normMetric) $normMetric.hidden = true;
}

// Instrumented fetch that also reports bytes
async function timedFetch(url) {
    const t0 = performance.now();
    const resp = await fetch(url);
    const text = await resp.text();
    const t1 = performance.now();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} · ${url.replace(FHIR_BASE, "")}`);
    bumpCallCounter();
    return { ms: t1 - t0, bytes: new Blob([text]).size, json: JSON.parse(text) };
}

// -------------------------------------------------------------------
// Live FHIR-call counter (persisted across visits in localStorage)
// -------------------------------------------------------------------
const CALL_COUNT_KEY = "ehrbridge.callCount";
function readCallCount() {
    const n = parseInt(localStorage.getItem(CALL_COUNT_KEY) || "0", 10);
    return Number.isFinite(n) ? n : 0;
}
function renderCallCount(n) {
    const el = document.getElementById("call-counter");
    if (el) el.textContent = n.toLocaleString();
}
function bumpCallCounter() {
    let n = readCallCount() + 1;
    try { localStorage.setItem(CALL_COUNT_KEY, String(n)); } catch (e) { /* ignore */ }
    renderCallCount(n);
}

// -------------------------------------------------------------------
// Terminal typing animation
// -------------------------------------------------------------------
function runTerminal() {
    const out = document.getElementById("terminal-output");
    const cursor = document.getElementById("terminal-cursor");
    if (!out) return;

    const lines = [
        { delay: 300, html: '<span class="prompt">$</span> <span class="cmd">whoami</span>\n' },
        { delay: 220, html: '<span class="out">Aniket Pathak — EHR Integration Engineer (Pune, IN)</span>\n\n' },
        { delay: 250, html: '<span class="prompt">$</span> <span class="cmd">cat stack.md</span>\n' },
        { delay: 170, html: '<span class="key">integrate</span>  <span class="out">FHIR R4/DSTU2 · HL7 v2 · REST · GraphQL · write-back</span>\n' },
        { delay: 170, html: '<span class="key">build</span>      <span class="out">Python · Django · FastAPI · Celery · PostgreSQL</span>\n' },
        { delay: 170, html: '<span class="key">ai</span>         <span class="out">LangGraph · LangChain · LLM APIs · Agentic AI</span>\n' },
        { delay: 170, html: '<span class="key">ship</span>       <span class="out">Docker · GitHub Actions · AWS · HIPAA · webhooks</span>\n\n' },
        { delay: 260, html: '<span class="prompt">$</span> <span class="cmd">echo $STATUS</span>\n' },
        { delay: 220, html: '<span class="str">"available for new projects · US-hours overlap · BAA on request"</span>\n' },
    ];

    let i = 0;
    function step() {
        if (i >= lines.length) {
            cursor.classList.add("is-done");
            return;
        }
        out.insertAdjacentHTML("beforeend", lines[i].html);
        i++;
        setTimeout(step, lines[i - 1].delay);
    }

    // Start when terminal is visible (so hero users actually see the effect)
    const term = document.getElementById("terminal");
    if (!term || !("IntersectionObserver" in window)) {
        step();
        return;
    }
    const io = new IntersectionObserver(
        (entries) => {
            if (entries.some((e) => e.isIntersecting)) {
                io.disconnect();
                step();
            }
        },
        { threshold: 0.3 }
    );
    io.observe(term);
}

// -------------------------------------------------------------------
// Command palette (⌘K / Ctrl+K)
// -------------------------------------------------------------------
function wireCmdK() {
    const root = document.getElementById("cmdk");
    const input = document.getElementById("cmdk-input");
    const list = document.getElementById("cmdk-list");
    const trigger = document.getElementById("cmdk-open");
    if (!root || !input || !list) return;

    const MAILTO = "mailto:aniketpathak34@gmail.com?subject=EHR%20integration%20project";
    const actions = [
        { group: "Actions", icon: "→", title: "Start a project", hint: "email me", run: () => { location.href = MAILTO; } },
        { group: "Actions", icon: "✉", title: "Copy email address", hint: "aniketpathak34@gmail.com", run: async () => {
            try {
                await navigator.clipboard.writeText("aniketpathak34@gmail.com");
                toast("Email copied to clipboard");
            } catch {
                location.href = MAILTO;
            }
        } },

        { group: "Go to", icon: "§", title: "Work with me — services", hint: "#services", run: () => jumpTo("#services") },
        { group: "Go to", icon: "§", title: "Case study — Ziva Health", hint: "#casestudy", run: () => jumpTo("#casestudy") },
        { group: "Go to", icon: "§", title: "More selected work", hint: "#work", run: () => jumpTo("#work") },
        { group: "Go to", icon: "§", title: "Integration coverage", hint: "#coverage", run: () => jumpTo("#coverage") },
        { group: "Go to", icon: "§", title: "Bridge Console (live demo)", hint: "#tryout", run: () => jumpTo("#tryout") },
        { group: "Go to", icon: "§", title: "FAQ", hint: "#faq", run: () => jumpTo("#faq") },
        { group: "Go to", icon: "§", title: "About", hint: "#about", run: () => jumpTo("#about") },
        { group: "Go to", icon: "§", title: "Contact", hint: "#contact", run: () => jumpTo("#contact") },

        { group: "Bridge Console", icon: "▸", title: "Switch to Patient tab", hint: "tab", run: () => { setTab("patient"); jumpTo("#tryout"); } },
        { group: "Bridge Console", icon: "▸", title: "Switch to Conditions tab", hint: "tab", run: () => { setTab("conditions"); jumpTo("#tryout"); } },
        { group: "Bridge Console", icon: "▸", title: "Switch to Medications tab", hint: "tab", run: () => { setTab("medications"); jumpTo("#tryout"); } },
        { group: "Bridge Console", icon: "▸", title: "Switch to Vitals tab", hint: "tab", run: () => { setTab("vitals"); jumpTo("#tryout"); } },

        { group: "Open", icon: "↗", title: "LinkedIn · aniket-pathak12", hint: "linkedin.com", run: () => window.open("https://linkedin.com/in/aniket-pathak12", "_blank") },
    ];

    let activeIdx = 0;
    let filtered = actions.slice();

    function open() {
        root.classList.add("is-open");
        root.setAttribute("aria-hidden", "false");
        input.value = "";
        filtered = actions.slice();
        activeIdx = 0;
        render();
        requestAnimationFrame(() => input.focus());
    }
    function close() {
        root.classList.remove("is-open");
        root.setAttribute("aria-hidden", "true");
    }

    function filter(q) {
        const s = q.trim().toLowerCase();
        if (!s) return actions.slice();
        return actions.filter((a) => {
            const hay = `${a.title} ${a.hint} ${a.group}`.toLowerCase();
            return s.split(/\s+/).every((tok) => hay.includes(tok));
        });
    }

    function render() {
        list.innerHTML = "";
        if (!filtered.length) {
            const li = document.createElement("li");
            li.className = "cmdk-empty";
            li.textContent = "No results.";
            list.appendChild(li);
            return;
        }
        let lastGroup = null;
        filtered.forEach((a, i) => {
            if (a.group !== lastGroup) {
                const head = document.createElement("li");
                head.className = "cmdk-group";
                head.textContent = a.group;
                list.appendChild(head);
                lastGroup = a.group;
            }
            const li = document.createElement("li");
            li.className = "cmdk-item" + (i === activeIdx ? " is-active" : "");
            li.dataset.idx = String(i);
            li.setAttribute("role", "option");
            li.innerHTML =
                `<span class="cmdk-item-icon">${a.icon}</span>` +
                `<span class="cmdk-item-text"><span class="cmdk-item-title"></span></span>` +
                `<span class="cmdk-item-hint"></span>`;
            li.querySelector(".cmdk-item-title").textContent = a.title;
            li.querySelector(".cmdk-item-hint").textContent = a.hint;
            li.addEventListener("mouseenter", () => { activeIdx = i; updateActive(); });
            li.addEventListener("click", () => run(i));
            list.appendChild(li);
        });
    }

    function updateActive() {
        const items = list.querySelectorAll(".cmdk-item");
        items.forEach((el) => {
            el.classList.toggle("is-active", Number(el.dataset.idx) === activeIdx);
            if (Number(el.dataset.idx) === activeIdx) {
                el.scrollIntoView({ block: "nearest" });
            }
        });
    }

    function run(idx) {
        const a = filtered[idx];
        if (!a) return;
        close();
        setTimeout(() => a.run(), 10);
    }

    function jumpTo(hash) {
        const el = document.querySelector(hash);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function toast(msg) {
        const t = document.createElement("div");
        t.textContent = msg;
        t.style.cssText =
            "position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);" +
            "background:#12151a;color:#e6e9ef;border:1px solid #232a33;" +
            "padding:.55rem 1rem;border-radius:8px;font-family:JetBrains Mono,monospace;" +
            "font-size:.82rem;z-index:300;box-shadow:0 10px 30px rgba(0,0,0,.4);";
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 1600);
    }

    // Events
    input.addEventListener("input", () => { filtered = filter(input.value); activeIdx = 0; render(); });
    input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(filtered.length - 1, activeIdx + 1); updateActive(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); updateActive(); }
        else if (e.key === "Enter") { e.preventDefault(); run(activeIdx); }
        else if (e.key === "Escape") { close(); }
    });
    root.querySelector("[data-cmdk-close]").addEventListener("click", close);
    if (trigger) trigger.addEventListener("click", open);

    window.addEventListener("keydown", (e) => {
        const k = e.key.toLowerCase();
        if ((e.metaKey || e.ctrlKey) && k === "k") { e.preventDefault(); open(); }
        else if (e.key === "Escape" && root.classList.contains("is-open")) { close(); }
        else if (e.key === "/" && !root.classList.contains("is-open")) {
            const tag = (document.activeElement && document.activeElement.tagName) || "";
            if (!["INPUT", "TEXTAREA", "SELECT"].includes(tag)) { e.preventDefault(); open(); }
        }
    });

    // Expose for other code (e.g., future plugins)
    window.__openCmdK = open;
}

// -------------------------------------------------------------------
// Scroll reveal
// -------------------------------------------------------------------
function wireScrollReveal() {
    // Whole-block reveals — fade up as one piece.
    const blocks = Array.from(document.querySelectorAll(
        ".hero, h2, .section-lede, .arch-diagram, .demo, .heatmap, .howiwork, .casestudy, .projects"
    ));
    // Grid items — these stagger one after another within their row.
    const items = Array.from(document.querySelectorAll(
        ".service-card, .contact-card, .faq details"
    ));
    const targets = blocks.concat(items);
    targets.forEach((el) => el.classList.add("fade-in"));

    // Stagger: each item waits a little longer than its left neighbour. The
    // delay is applied to WHEN .is-visible is added (via setTimeout), not as a
    // CSS transition-delay — so hover transitions stay instant afterwards.
    items.forEach((el) => {
        const idx = Array.prototype.indexOf.call(el.parentElement.children, el);
        el.dataset.revealDelay = String(Math.min(idx, 8) * 65);
    });

    if (!("IntersectionObserver" in window)) {
        targets.forEach((el) => el.classList.add("is-visible"));
        return;
    }
    const io = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const delay = +entry.target.dataset.revealDelay || 0;
                if (delay) {
                    setTimeout(() => entry.target.classList.add("is-visible"), delay);
                } else {
                    entry.target.classList.add("is-visible");
                }
                io.unobserve(entry.target);
            }
        },
        { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    targets.forEach((el) => io.observe(el));
}

// -------------------------------------------------------------------
// Hero terminal — subtle 3D tilt that follows the cursor
// -------------------------------------------------------------------
function wireHeroTilt() {
    const card = document.getElementById("hero-terminal");
    if (!card) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia("(hover: none)").matches) return;
    const wrap = card.parentElement;
    wrap.addEventListener("mousemove", (e) => {
        const r = wrap.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform =
            `perspective(900px) rotateX(${(-py * 5).toFixed(2)}deg) ` +
            `rotateY(${(px * 6).toFixed(2)}deg)`;
    });
    wrap.addEventListener("mouseleave", () => { card.style.transform = ""; });
}

// -------------------------------------------------------------------
// Hero terminal — types a live-style FHIR transformation
// -------------------------------------------------------------------
function runHeroTerminal() {
    const out = document.getElementById("hero-terminal-output");
    const cursor = document.getElementById("hero-terminal-cursor");
    if (!out) return;

    const lines = [
        { d: 320, h: '<span class="prompt">$</span> <span class="cmd">curl /ehr-bridge/Patient/smart-1413</span>\n' },
        { d: 480, h: '<span class="out">→ upstream: eClinicalWorks · legacy envelope</span>\n\n' },
        { d: 70,  h: '<span class="out">  {"Response":{"ResponseCode":"0","PatientInfo":[</span>\n' },
        { d: 70,  h: '<span class="out">    {"FName":"PRIYA","LName":"SHAH",</span>\n' },
        { d: 620, h: '<span class="out">     "DOB":"04/12/1987","Sex":"F"}]}}</span>\n\n' },
        { d: 520, h: '<span class="out">→ normalizing…</span>\n\n' },
        { d: 70,  h: '  {<span class="j-key">"patient_id"</span>: <span class="j-string">"smart-1413"</span>,\n' },
        { d: 70,  h: '   <span class="j-key">"name"</span>: {<span class="j-key">"first"</span>: <span class="j-string">"Priya"</span>, <span class="j-key">"last"</span>: <span class="j-string">"Shah"</span>},\n' },
        { d: 70,  h: '   <span class="j-key">"dob"</span>: <span class="j-string">"1987-04-12"</span>,\n' },
        { d: 600, h: '   <span class="j-key">"gender"</span>: <span class="j-string">"female"</span>}\n\n' },
        { d: 200, h: '<span class="str">✓ 200 OK · one schema, every EHR · 14 ms</span>\n' },
    ];

    let i = 0;
    function step() {
        if (i >= lines.length) { cursor.classList.add("is-done"); return; }
        out.insertAdjacentHTML("beforeend", lines[i].h);
        i++;
        setTimeout(step, lines[i - 1].d);
    }

    const term = document.getElementById("hero-terminal");
    if (!term || !("IntersectionObserver" in window)) { step(); return; }
    const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { io.disconnect(); step(); }
    }, { threshold: 0.25 });
    io.observe(term);
}

// -------------------------------------------------------------------
// EHR logo marquee
// -------------------------------------------------------------------
const EHR_LIST = [
    "Epic", "Athena", "Cerner", "eClinicalWorks", "NextGen", "Allscripts",
    "Elation", "OpenEMR", "Nextech", "DrChrono", "ModMed", "Meditech",
    "Office Practicum", "Praxis EHR", "MedHost", "McKesson", "Greenway Health",
    "CareCloud", "EyeMD", "Amazing Charts", "Cerbo", "CharmHealth", "MDLogic",
    "Canvas Medical", "Open Dental", "Alligence", "ALIS", "OncoEMR",
    "Practice Fusion", "PointClickCare", "AdvancedMD", "Tebra", "IntakeQ",
    "Innerwell", "Healthie", "Wellkin", "Office Ally", "Eaglesoft", "HeyDonto",
    "CareStack", "Denticon", "Dentrix Ascend",
];
function populateMarquee() {
    const track = document.getElementById("marquee-track");
    if (!track) return;
    // Duplicate the list so the -50% translate loops seamlessly.
    const items = EHR_LIST.concat(EHR_LIST);
    track.innerHTML = items
        .map((n) => `<span class="marquee-item">${n}</span>`)
        .join("");
}

// -------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------
wireScrollReveal();
wireCmdK();
runTerminal();
runHeroTerminal();
populateMarquee();
renderCallCount(readCallCount());
updateRequestPreview();
populatePatientDropdown();

// -------------------------------------------------------------------
// Scroll chrome — progress bar, header shadow, nav scroll-spy
// -------------------------------------------------------------------
function wireScrollChrome() {
    const bar = document.getElementById("scroll-progress");
    const header = document.querySelector(".site-header");
    let ticking = false;
    function update() {
        const doc = document.documentElement;
        const max = doc.scrollHeight - doc.clientHeight;
        const pct = max > 0 ? doc.scrollTop / max : 0;
        if (bar) bar.style.transform = `scaleX(${pct})`;
        if (header) header.classList.toggle("is-scrolled", doc.scrollTop > 8);
        ticking = false;
    }
    window.addEventListener("scroll", () => {
        if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
}

function wireScrollSpy() {
    const links = Array.from(document.querySelectorAll('nav a[href^="#"]'));
    const map = new Map();
    links.forEach((a) => {
        const sec = document.getElementById(a.getAttribute("href").slice(1));
        if (sec) map.set(sec, a);
    });
    if (!map.size || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
            if (!e.isIntersecting) return;
            links.forEach((l) => l.classList.remove("is-active"));
            const a = map.get(e.target);
            if (a) a.classList.add("is-active");
        });
    }, { rootMargin: "-45% 0px -50% 0px" });
    map.forEach((_, sec) => io.observe(sec));
}

// -------------------------------------------------------------------
// "More selected work" — horizontal sliding carousel
// -------------------------------------------------------------------
function wireWorkSlider() {
    const track = document.getElementById("work-track");
    const prev = document.getElementById("work-prev");
    const next = document.getElementById("work-next");
    if (!track || !prev || !next) return;

    function cardStep() {
        const card = track.querySelector(".project-card");
        if (!card) return 320;
        const gap = parseFloat(getComputedStyle(track).gap) || 16;
        return card.getBoundingClientRect().width + gap;
    }
    function sync() {
        const max = track.scrollWidth - track.clientWidth - 2;
        const noScroll = max <= 2;
        prev.disabled = noScroll || track.scrollLeft <= 2;
        next.disabled = noScroll || track.scrollLeft >= max;
    }
    prev.addEventListener("click", () => track.scrollBy({ left: -cardStep(), behavior: "smooth" }));
    next.addEventListener("click", () => track.scrollBy({ left: cardStep(), behavior: "smooth" }));
    track.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    sync();
}

// -------------------------------------------------------------------
// Coverage — turn the 40+ EHR grid into a compact 3-row auto-scroller
// -------------------------------------------------------------------
function wireEhrMarquee() {
    const grid = document.querySelector(".ehr-grid");
    if (!grid) return;
    const tiles = Array.from(grid.querySelectorAll(".ehr-tile"));
    if (tiles.length < 9) return;  // a short list reads fine as a plain grid

    const ROWS = 3;
    const rows = [[], [], []];
    tiles.forEach((tile, i) => rows[i % ROWS].push(tile));

    const marquee = document.createElement("div");
    marquee.className = "ehr-marquee";
    rows.forEach((rowTiles, idx) => {
        const row = document.createElement("div");
        row.className = "ehr-row" + (idx === 1 ? " rev" : idx === 2 ? " slow" : "");
        rowTiles.forEach((t) => row.appendChild(t));            // originals
        rowTiles.forEach((t) => {                               // clones → seamless loop
            const c = t.cloneNode(true);
            c.setAttribute("aria-hidden", "true");
            row.appendChild(c);
        });
        marquee.appendChild(row);
    });
    grid.replaceWith(marquee);
}

// -------------------------------------------------------------------
// Count-up — numbers tick from 0 to their value when scrolled into view
// -------------------------------------------------------------------
function wireCountUp() {
    const els = Array.from(document.querySelectorAll(".count"));
    if (!els.length) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function run(el) {
        const to = parseInt(el.dataset.countTo, 10) || 0;
        if (reduce) { el.textContent = String(to); return; }
        const dur = 1100;
        const start = performance.now();
        (function tick(now) {
            const p = Math.min(1, (now - start) / dur);
            const eased = 1 - Math.pow(1 - p, 3);  // ease-out cubic
            el.textContent = String(Math.round(to * eased));
            if (p < 1) requestAnimationFrame(tick);
            else el.textContent = String(to);
        })(start);
    }

    if (!("IntersectionObserver" in window)) { els.forEach(run); return; }
    els.forEach((el) => { if (!reduce) el.textContent = "0"; });
    const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
            if (!e.isIntersecting) return;
            run(e.target);
            io.unobserve(e.target);
        });
    }, { threshold: 0.6 });
    els.forEach((el) => io.observe(el));
}

wireScrollChrome();
wireScrollSpy();
wireHeroTilt();
wireWorkSlider();
wireEhrMarquee();
wireCountUp();

// -------------------------------------------------------------------
// Bridge Console — make the live demo react on every fetch.
// Non-invasive: observes the panels, never touches the demo's own logic.
// -------------------------------------------------------------------
function wireBridgeAnim() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    function onChange(el, fn) {
        if (!el) return;
        new MutationObserver(fn).observe(el, {
            childList: true, characterData: true, subtree: true
        });
    }
    function replay(el, cls) {
        if (!el) return;
        el.classList.remove(cls);
        void el.offsetWidth;          // force reflow → restart the animation
        el.classList.add(cls);
    }

    const raw = document.getElementById("raw-response");
    const norm = document.getElementById("normalized-response");
    const counter = document.getElementById("call-counter");
    const accentPanel = norm ? norm.closest(".demo-panel-accent") : null;

    onChange(raw, () => replay(raw, "bridge-fresh"));
    onChange(norm, () => {
        replay(norm, "bridge-fresh");
        replay(accentPanel, "bridge-pulse");
    });
    onChange(counter, () => replay(counter, "bridge-bump"));
}

wireBridgeAnim();

// -------------------------------------------------------------------
// Bridge Console — measure the raw → normalized reduction, on every fetch.
// This is the actual value prop, quantified live: vendor mess vs. clean output.
// -------------------------------------------------------------------
function wireTransformReadout() {
    const rawEl  = document.getElementById("raw-response");
    const normEl = document.getElementById("normalized-response");
    const box    = document.getElementById("xform");
    if (!rawEl || !normEl || !box) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function parse(el) {
        const t = (el.textContent || "").trim();
        if (!t || t === "—") return null;
        try { return JSON.parse(t); } catch (e) { return null; }
    }
    function countKeys(v) {
        if (Array.isArray(v)) return v.reduce((s, x) => s + countKeys(x), 0);
        if (v && typeof v === "object") {
            return Object.keys(v).length +
                   Object.values(v).reduce((s, x) => s + countKeys(x), 0);
        }
        return 0;
    }
    function depth(v) {
        if (Array.isArray(v)) return v.length ? 1 + Math.max.apply(null, v.map(depth)) : 1;
        if (v && typeof v === "object") {
            const vals = Object.values(v);
            return vals.length ? 1 + Math.max.apply(null, vals.map(depth)) : 1;
        }
        return 0;
    }
    function countTo(el, to) {
        if (reduce) { el.textContent = String(to); return; }
        const start = performance.now(), dur = 620;
        (function tick(now) {
            const p = Math.min(1, (now - start) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = String(Math.round(to * eased));
            if (p < 1) requestAnimationFrame(tick);
            else el.textContent = String(to);
        })(start);
    }

    const elRawFields  = document.getElementById("xf-raw-fields");
    const elRawDepth   = document.getElementById("xf-raw-depth");
    const elNormFields = document.getElementById("xf-norm-fields");
    const elNormDepth  = document.getElementById("xf-norm-depth");
    const elVerdict    = document.getElementById("xf-verdict");

    function update() {
        const r = parse(rawEl), n = parse(normEl);
        if (!r || !n) { box.hidden = true; return; }
        const rf = countKeys(r), nf = countKeys(n);
        if (rf === 0 || nf === 0) { box.hidden = true; return; }
        const rd = depth(r), nd = depth(n);

        box.hidden = false;
        countTo(elRawFields, rf);
        countTo(elNormFields, nf);
        elRawDepth.textContent  = "nested " + rd + " deep";
        elNormDepth.textContent = nd <= 3 ? "flat" : nd + " deep";

        const cut = rf > nf ? Math.round((1 - nf / rf) * 100) : 0;
        elVerdict.innerHTML = "Same patient. Same clinical facts. The vendor's <b>" +
            rf + "-field</b> payload becomes <b>" + nf + " flat fields</b>" +
            (cut > 0 ? " — <b>" + cut + "% less</b> for your app to parse." : ".");

        box.classList.remove("is-fresh");
        void box.offsetWidth;
        box.classList.add("is-fresh");
    }

    const opts = { childList: true, characterData: true, subtree: true };
    new MutationObserver(update).observe(rawEl, opts);
    new MutationObserver(update).observe(normEl, opts);
}

wireTransformReadout();
