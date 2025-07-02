const path = require('path');
const fs = require('fs');
const { parseJUnit, parseHTML, parseExcel } = require('./parsers');
/**
 * Publishes test reports by sending them to a specified server API.
 * @param {object} config - The configuration object.
 * @param {string} config.serverApiUrl - The URL of the server API endpoint to send test reports.
 * @param {string} config.userId - The user ID for the test run.
 * @param {string} config.projectId - The UUID of the project (REQUIRED by backend).
 * @param {string} config.apiKey - The API key for authentication (REQUIRED by backend).
 * @param {string} config.reportsDir - Directory containing test reports.
 * @param {string} [config.name] - Name of the test run.
 * @param {string} [config.environment] - Environment of the test run.
 * @param {string} [config.branch] - Branch of the test run.
 * @param {string} [config.commit] - Commit hash of the test run.
 * @param {string} [config.startTime] - Start time (ISO string).
 * @param {string} [config.endTime] - End time (ISO string).
 */
async function publishTestReports(config) {
    console.log('Starting test results publishing...');

    if (!config.serverApiUrl) {
        throw new Error('serverApiUrl is required in the configuration.');
    }
    if (!config.userId) {
        throw new Error('userId is required in the configuration.');
    }
    if (!config.projectId) {
        throw new Error('projectId (UUID) is required in the configuration.');
    }
    if (!config.apiKey) {
        throw new Error('apiKey is required in the configuration.');
    }
    if (!config.reportsDir) {
        throw new Error('reportsDir is required in the configuration.');
    }

    console.log('Scanning reports directory:', config.reportsDir);
    const reportsDir = path.resolve(config.reportsDir);
    const files = fs.readdirSync(reportsDir)
        .filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.xml', '.html', '.xlsx', '.xls'].includes(ext);
        })
        .map(file => path.join(reportsDir, file));

    if (files.length === 0) {
        throw new Error(`No report files found in ${reportsDir}`);
    }

    console.log('Found report files:', files);

    const allTestCases = [];
    const summary = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0
    };
    let suiteNames = [];

    for (const filePath of files) {
        const ext = path.extname(filePath).toLowerCase();
        console.log('Processing file:', filePath);

        let result;
        switch (ext) {
            case '.xml':
                console.log('Parsing JUnit XML file...');
                result = await parseJUnit(filePath);
                // Collect suite names from JUnit XML
                if (result && result.testCases && result.testCases.length > 0) {
                    const uniqueSuites = [...new Set(result.testCases.map(tc => tc.suite).filter(Boolean))];
                    suiteNames = suiteNames.concat(uniqueSuites);
                }
                break;
            case '.html':
                console.log('Parsing HTML file...');
                result = await parseHTML(filePath);
                break;
            case '.xlsx':
            case '.xls':
                console.log('Parsing Excel file...');
                result = await parseExcel(filePath);
                break;
            default:
                console.warn(`Unsupported file type: ${ext}`);
                continue;
        }

        console.log('File parsed successfully:', {
            total: result.summary.total,
            passed: result.summary.passed,
            failed: result.summary.failed,
            skipped: result.summary.skipped
        });

        summary.total += result.summary.total;
        summary.passed += result.summary.passed;
        summary.failed += result.summary.failed;
        summary.skipped += result.summary.skipped;
        summary.duration += result.summary.duration;
        allTestCases.push(...result.testCases);
    }

    // Build payload for backend
    const runName = suiteNames.length > 0 ? suiteNames.join(', ') : (config.name || 'Test Run');
    const payload = {
        testRun: {
            name: runName,
            userId: config.userId,
            projectId: config.projectId,
            environment: config.environment || null,
            branch: config.branch || null,
            commit: config.commit || null,
            startTime: config.startTime || new Date().toISOString(),
            endTime: config.endTime || new Date().toISOString()
        },
        testCases: allTestCases.map(testCase => ({
            title: testCase.title || '',
            status: testCase.status,
            duration: Number.isInteger(testCase.duration) ? testCase.duration : Math.round(testCase.duration),
            errorMessage: testCase.errorMessage ? String(testCase.errorMessage) : '',
            errorStack: testCase.errorStack ? String(testCase.errorStack) : '',
            file: testCase.file || '',
            suite: testCase.suite || '',
            // Add other optional fields as needed
        }))
    };

    console.log('Sending test results to server...');
    try {
        const response = await fetch(config.serverApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server responded with an error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        console.log('Test results published successfully to server!');
    } catch (error) {
        console.error('Failed to send test results to server:', error.message);
        throw error; // Re-throw to be caught by main cli.js error handler
    }
}

module.exports = { publishTestReports };
// ... existing code ...