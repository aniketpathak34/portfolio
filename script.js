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

async function fetchPatientTab(pid) {
    const ehr = $ehr.value;
    setStatus(ehr === "epic" ? "Calling SMART Health IT FHIR sandbox…" : "Synthesizing ECW envelope…");
    if (!currentPatient || currentPatient.id !== pid) {
        currentPatient = await fetchFhirPatient(pid);
    }
    let rawResponse, key;
    if (ehr === "epic") {
        rawResponse = currentPatient;
        key = "epic";
    } else {
        rawResponse = synthesizeEcwEnvelope(currentPatient);
        key = "ecw";
    }
    const normalized = PATIENT_TRANSFORMERS[key](rawResponse);
    $raw.innerHTML = highlightJson(rawResponse);
    $norm.innerHTML = highlightJson(normalized);
    const tag = ehr === "epic" ? "live FHIR R4" : "simulated ECW";
    setStatus(`200 OK · ${tag} · normalized via ${key.toUpperCase()} transformer`, "ok");
}

async function fetchResourceTab(tab, pid) {
    setStatus(`Calling SMART Health IT sandbox for ${tab}…`);
    const bundle = await fetchJson(RESOURCES[tab].endpoint(pid));
    const normalized = RESOURCES[tab].normalize(bundle);
    $raw.innerHTML = highlightJson(bundle);
    $norm.innerHTML = highlightJson(normalized);
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
// Scroll reveal
// -------------------------------------------------------------------
function wireScrollReveal() {
    const targets = document.querySelectorAll("section, .hero, .project-card, .arch-diagram, .demo");
    targets.forEach((el) => el.classList.add("fade-in"));
    if (!("IntersectionObserver" in window)) {
        targets.forEach((el) => el.classList.add("is-visible"));
        return;
    }
    const io = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    entry.target.classList.add("is-visible");
                    io.unobserve(entry.target);
                }
            }
        },
        { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    targets.forEach((el) => io.observe(el));
}

// -------------------------------------------------------------------
// Boot
// -------------------------------------------------------------------
wireScrollReveal();
updateRequestPreview();
populatePatientDropdown();
