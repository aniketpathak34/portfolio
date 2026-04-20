document.getElementById('ehr-select').addEventListener('change', function() {
    const ehr = this.value;
    if (!ehr) {
        document.getElementById('patient-info').innerHTML = '';
        return;
    }

    // Simulate API call
    fetchPatientData(ehr).then(data => {
        displayPatientData(data);
    });
});

function fetchPatientData(ehr) {
    // Mock API response
    return new Promise((resolve) => {
        setTimeout(() => {
            const mockData = {
                ecw: {
                    patientId: '12345',
                    name: 'John Doe',
                    dob: '1980-01-01',
                    system: 'ECW'
                },
                epic: {
                    patientId: '67890',
                    name: 'Jane Smith',
                    dob: '1990-05-15',
                    system: 'Epic'
                }
            };
            resolve(mockData[ehr]);
        }, 500); // Simulate delay
    });
}

function displayPatientData(data) {
    const infoDiv = document.getElementById('patient-info');
    infoDiv.innerHTML = `
        <h3>Patient Details from ${data.system}</h3>
        <p><strong>Patient ID:</strong> ${data.patientId}</p>
        <p><strong>Name:</strong> ${data.name}</p>
        <p><strong>Date of Birth:</strong> ${data.dob}</p>
        <p><strong>EHR System:</strong> ${data.system}</p>
    `;
}