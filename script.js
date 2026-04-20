// Year in footer
document.getElementById('year').textContent = new Date().getFullYear();

// --- Mock EHR data --------------------------------------------------
// The point of this demo: two wildly different raw payloads from two
// different EHRs collapse into ONE normalized shape the client can rely on.

const RAW_RESPONSES = {
    ecw: {
        // ECW returns a SOAP-ish JSON-wrapped envelope
        ResponseHeader: {
            Status: "OK",
            ServerDateTime: "2026-04-21T09:14:02-05:00",
        },
        PatientInformation: {
            PatientID: "P-10042",
            PatientName: {
                FirstName: "Priya",
                LastName: "Shah",
                MiddleInitial: "R",
            },
            DOB: "04/12/1987",
            Gender: "F",
            ContactInfo: {
                HomePhone: "+1-415-555-0142",
                EmailAddress: "priya.shah@example.com",
            },
            Address: {
                AddressLine1: "221B Market Street",
                City: "San Francisco",
                State: "CA",
                ZipCode: "94103",
            },
            PrimaryProvider: "Dr. Alan Webb",
            LastEncounter: "03/29/2026",
        },
    },
    epic: {
        // Epic / OpenEpic returns FHIR R4
        resourceType: "Patient",
        id: "P-10042",
        name: [{ given: ["Priya", "R"], family: "Shah", use: "official" }],
        birthDate: "1987-04-12",
        gender: "female",
        telecom: [
            { system: "phone", value: "+1-415-555-0142", use: "home" },
            { system: "email", value: "priya.shah@example.com" },
        ],
        address: [
            {
                line: ["221B Market Street"],
                city: "San Francisco",
                state: "CA",
                postalCode: "94103",
                country: "US",
            },
        ],
        generalPractitioner: [{ display: "Dr. Alan Webb" }],
        extension: [
            {
                url: "https://fhir.openepic.com/StructureDefinition/last-encounter",
                valueDate: "2026-03-29",
            },
        ],
    },
};

// Transformers — mirror the pattern in the real bridge (one per EHR,
// both return the same normalized shape).
const TRANSFORMERS = {
    ecw(raw) {
        const p = raw.PatientInformation;
        const name = p.PatientName;
        return {
            patient_id: p.PatientID,
            name: {
                first: name.FirstName,
                middle: name.MiddleInitial || null,
                last: name.LastName,
            },
            date_of_birth: toIsoDate(p.DOB),
            gender: p.Gender === "F" ? "female" : p.Gender === "M" ? "male" : "unknown",
            contact: {
                phone: p.ContactInfo.HomePhone,
                email: p.ContactInfo.EmailAddress,
            },
            address: {
                line1: p.Address.AddressLine1,
                city: p.Address.City,
                state: p.Address.State,
                postal_code: p.Address.ZipCode,
                country: "US",
            },
            primary_provider: p.PrimaryProvider,
            last_encounter_date: toIsoDate(p.LastEncounter),
            source_ehr: "eclinicalworks",
        };
    },
    epic(raw) {
        const nm = raw.name?.[0] || {};
        const phone = (raw.telecom || []).find((t) => t.system === "phone");
        const email = (raw.telecom || []).find((t) => t.system === "email");
        const addr = raw.address?.[0] || {};
        const lastEnc = (raw.extension || []).find((e) => e.url?.endsWith("last-encounter"));
        return {
            patient_id: raw.id,
            name: {
                first: nm.given?.[0] || null,
                middle: nm.given?.[1] || null,
                last: nm.family || null,
            },
            date_of_birth: raw.birthDate,
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
            last_encounter_date: lastEnc?.valueDate || null,
            source_ehr: "epic",
        };
    },
};

function toIsoDate(mdY) {
    // "04/12/1987" -> "1987-04-12"
    if (!mdY) return null;
    const parts = mdY.split("/");
    if (parts.length !== 3) return mdY;
    const [m, d, y] = parts;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// --- Rendering ------------------------------------------------------

function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Tiny JSON pretty-printer with syntax highlighting via CSS classes.
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

// --- Wire it up -----------------------------------------------------

const $ehr = document.getElementById("ehr-select");
const $pid = document.getElementById("patient-id");
const $btn = document.getElementById("fetch-btn");
const $req = document.getElementById("request-preview");
const $raw = document.getElementById("raw-response");
const $norm = document.getElementById("normalized-response");
const $rawHint = document.getElementById("raw-hint");
const $status = document.getElementById("status");

function updateRequestPreview() {
    const ehr = $ehr.value;
    const pid = encodeURIComponent($pid.value.trim() || "P-10042");
    $req.textContent = `GET /api/v1/clinical-summary/patient?ehr=${ehr}&patient_id=${pid}`;
    $rawHint.textContent = ehr === "ecw" ? "ECW shape (JSON envelope)" : "Epic shape (FHIR R4)";
}

function setStatus(msg, kind = "") {
    $status.textContent = msg;
    $status.className = "demo-status" + (kind ? " " + kind : "");
}

async function fetchPatient() {
    const ehr = $ehr.value;
    const pid = $pid.value.trim();
    if (!pid) {
        setStatus("Please enter a patient ID.", "err");
        return;
    }
    $btn.disabled = true;
    setStatus("Fetching…");

    // Simulate network
    await new Promise((r) => setTimeout(r, 450));

    const raw = RAW_RESPONSES[ehr];
    if (!raw) {
        setStatus("Unsupported EHR.", "err");
        $btn.disabled = false;
        return;
    }

    // Clone + inject the requested patient_id so the demo honors the input.
    const rawClone = JSON.parse(JSON.stringify(raw));
    if (ehr === "ecw") rawClone.PatientInformation.PatientID = pid;
    else rawClone.id = pid;

    const normalized = TRANSFORMERS[ehr](rawClone);

    $raw.innerHTML = highlightJson(rawClone);
    $norm.innerHTML = highlightJson(normalized);
    setStatus(`200 OK · normalized via ${ehr.toUpperCase()} transformer`, "ok");
    $btn.disabled = false;
}

$ehr.addEventListener("change", updateRequestPreview);
$pid.addEventListener("input", updateRequestPreview);
$btn.addEventListener("click", fetchPatient);

// Initial state
updateRequestPreview();
fetchPatient();
