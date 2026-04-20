// Year in footer
document.getElementById('year').textContent = new Date().getFullYear();

// -------------------------------------------------------------------
// Live FHIR R4 sandbox (SMART Health IT — public, CORS-enabled, Synthea data)
// -------------------------------------------------------------------
const FHIR_BASE = "https://r4.smarthealthit.org";
const SAMPLE_COUNT = 6;

// -------------------------------------------------------------------
// Data helpers
// -------------------------------------------------------------------

async function fetchPatientList() {
    const resp = await fetch(`${FHIR_BASE}/Patient?_count=${SAMPLE_COUNT}&_sort=-_lastUpdated`);
    if (!resp.ok) throw new Error(`Patient list fetch failed: HTTP ${resp.status}`);
    const bundle = await resp.json();
    return (bundle.entry || []).map((e) => e.resource).filter(Boolean);
}

async function fetchFhirPatient(id) {
    const resp = await fetch(`${FHIR_BASE}/Patient/${encodeURIComponent(id)}`);
    if (!resp.ok) throw new Error(`Patient fetch failed: HTTP ${resp.status}`);
    return resp.json();
}

function patientDisplayName(patient) {
    const nm = patient.name?.[0];
    if (!nm) return patient.id;
    const given = (nm.given || []).join(" ");
    return `${given} ${nm.family || ""}`.trim() || patient.id;
}

// Build an ECW-flavored response from a real FHIR patient.  Shape mirrors
// eClinicalWorks' legacy EMR Web / EBO API (non-FHIR): Response envelope
// with ResponseCode/ResponseMessage and a PatientInfo array of records.
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

function mdyToIso(mdy) {
    if (!mdy) return null;
    const parts = mdy.split("/");
    if (parts.length !== 3) return mdy;
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// -------------------------------------------------------------------
// Transformers — one per EHR, both return the same normalized shape.
// -------------------------------------------------------------------
const TRANSFORMERS = {
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
// Rendering
// -------------------------------------------------------------------

function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
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
// Wire-up
// -------------------------------------------------------------------
const $ehr = document.getElementById("ehr-select");
const $pid = document.getElementById("patient-id");
const $btn = document.getElementById("fetch-btn");
const $req = document.getElementById("request-preview");
const $raw = document.getElementById("raw-response");
const $norm = document.getElementById("normalized-response");
const $rawHint = document.getElementById("raw-hint");
const $status = document.getElementById("status");

// Cache the real FHIR patient we've loaded, so ECW can synthesize from it
// without hitting the network again.
let currentPatient = null;

function updateRequestPreview() {
    const ehr = $ehr.value;
    const pid = $pid.value || "—";
    if (ehr === "epic") {
        $req.textContent = `GET ${FHIR_BASE}/Patient/${pid}`;
        $rawHint.textContent = "Live · FHIR R4";
    } else {
        $req.textContent = `GET /api/v1/clinical-summary/patient?ehr=ecw&patient_id=${pid}`;
        $rawHint.textContent = "Simulated · ECW envelope";
    }
}

function setStatus(msg, kind = "") {
    $status.textContent = msg;
    $status.className = "demo-status" + (kind ? " " + kind : "");
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
        setStatus("Ready. Pick an EHR and hit Fetch patient.", "ok");
        updateRequestPreview();
        // Kick off an initial fetch so the demo isn't empty.
        fetchPatient();
    } catch (err) {
        setStatus(`Couldn't load patient list: ${err.message}`, "err");
    }
}

async function fetchPatient() {
    const ehr = $ehr.value;
    const pid = $pid.value;
    if (!pid) {
        setStatus("Pick a patient first.", "err");
        return;
    }
    $btn.disabled = true;
    setStatus(ehr === "epic" ? "Calling SMART Health IT FHIR sandbox…" : "Synthesizing ECW envelope…");

    try {
        // Always fetch the real FHIR patient (live).  For ECW we then
        // reshape the same patient into an ECW envelope.
        if (!currentPatient || currentPatient.id !== pid) {
            currentPatient = await fetchFhirPatient(pid);
        }

        let rawResponse, transformerKey;
        if (ehr === "epic") {
            rawResponse = currentPatient;
            transformerKey = "epic";
        } else {
            rawResponse = synthesizeEcwEnvelope(currentPatient);
            transformerKey = "ecw";
        }

        const normalized = TRANSFORMERS[transformerKey](rawResponse);

        $raw.innerHTML = highlightJson(rawResponse);
        $norm.innerHTML = highlightJson(normalized);

        const tag = ehr === "epic" ? "live FHIR R4" : "simulated ECW";
        setStatus(`200 OK · ${tag} · normalized via ${transformerKey.toUpperCase()} transformer`, "ok");
    } catch (err) {
        setStatus(`Error: ${err.message}`, "err");
        $raw.textContent = "—";
        $norm.textContent = "—";
    } finally {
        $btn.disabled = false;
    }
}

$ehr.addEventListener("change", () => {
    updateRequestPreview();
    fetchPatient();
});
$pid.addEventListener("change", () => {
    currentPatient = null;
    updateRequestPreview();
    fetchPatient();
});
$btn.addEventListener("click", fetchPatient);

// Initial load
updateRequestPreview();
populatePatientDropdown();
