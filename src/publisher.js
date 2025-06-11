const fs = require('fs');
const path = require('path');
const { parseJUnit, parseHTML, parseExcel } = require('./parsers');
const fetch = require('node-fetch'); // Ensure you have installed node-fetch: npm install node-fetch

/**
 * Publishes test reports by sending them to a specified server API.
 * @param {object} config - The configuration object.
 * @param {string} config.serverApiUrl - The URL of the server API endpoint to send test reports.
 * @param {string} config.userId - The user ID for the test run.
 * @param {string} config.projectName - The name of the project.
 * @param {string} [config.projectDescription] - Description of the project.
 * @param {string} config.reportsDir - Directory containing test reports.
 * @param {string} [config.name] - Name of the test run.
 * @param {string} [config.environment] - Environment of the test run.
 * @param {string} [config.branch] - Branch of the test run.
 * @param {string} [config.commit] - Commit hash of the test run.
 */
async function publishTestReports(config) {
    console.log('Starting test results publishing...');

    if (!config.serverApiUrl) {
        throw new Error('serverApiUrl is required in the configuration.');
    }

    if (!config.userId) {
        throw new Error('userId is required in the configuration.');
    }

    if (!config.projectName) {
        throw new Error('projectName is required in the configuration.');
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

    for (const filePath of files) {
        const ext = path.extname(filePath).toLowerCase();
        console.log('Processing file:', filePath);

        let result;
        switch (ext) {
            case '.xml':
                console.log('Parsing JUnit XML file...');
                result = await parseJUnit(filePath);
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

    const payload = {
        userId: config.userId,
        projectName: config.projectName,
        projectDescription: config.projectDescription,
        name: config.name || 'Test Run',
        environment: config.environment,
        branch: config.branch,
        commit: config.commit,
        totalTests: summary.total,
        passedTests: summary.passed,
        failedTests: summary.failed,
        skippedTests: summary.skipped,
        totalDuration: summary.duration,
        testCases: allTestCases,
        status: summary.failed > 0 ? 'failed' : 'passed'
    };

    console.log('Sending test results to server...');
    try {
        const response = await fetch(config.serverApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
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

module.exports = {
    publishTestReports
}; 