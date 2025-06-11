const fs = require('fs');
const path = require('path');
const { parseJUnit, parseHTML, parseExcel } = require('./parsers');
const { sequelize, Project, TestRun, TestCase, initDatabase } = require('./models');

/**
 * Publishes test reports based on the provided configuration.
 * @param {object} config - The configuration object.
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

    if (!config.userId) {
        throw new Error('userId is required in the configuration.');
    }

    if (!config.projectName) {
        throw new Error('projectName is required in the configuration.');
    }

    if (!config.reportsDir) {
        throw new Error('reportsDir is required in the configuration.');
    }

    console.log('Initializing database...');
    await initDatabase();
    console.log('Database initialized successfully');

    console.log('Looking up project:', config.projectName);
    let project = await Project.findOne({ where: { name: config.projectName } });
    if (!project) {
        console.log('Project not found, creating new project...');
        project = await Project.create({
            name: config.projectName,
            description: config.projectDescription || '',
            status: 'Active'
        });
        console.log('Project created:', project.id);
    } else {
        console.log('Found existing project:', project.id);
    }

    console.log('Creating test run...');
    const testRun = await TestRun.create({
        userId: config.userId,
        projectId: project.id,
        name: config.name || 'Test Run',
        status: 'running',
        startTime: new Date(),
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        totalDuration: 0,
        environment: config.environment,
        branch: config.branch,
        commit: config.commit
    });
    console.log('Test run created:', testRun.id);

    const summary = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0
    };

    const reportsDir = path.resolve(config.reportsDir);
    console.log('Scanning reports directory:', reportsDir);
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

        console.log('Creating test cases...');
        await TestCase.bulkCreate(
            result.testCases.map(testCase => ({
                testRunId: testRun.id,
                name: testCase.name,
                status: testCase.status,
                duration: testCase.duration,
                errorMessage: testCase.errorMessage,
                errorStack: testCase.errorStack,
                file: testCase.file
            }))
        );
        console.log('Test cases created successfully');
    }

    console.log('Updating test run with final statistics...');
    await testRun.update({
        status: summary.failed > 0 ? 'failed' : 'passed',
        endTime: new Date(),
        totalTests: summary.total,
        passedTests: summary.passed,
        failedTests: summary.failed,
        skippedTests: summary.skipped,
        totalDuration: summary.duration
    });

    console.log('Test results published successfully!');
    console.log('Project:', project.name);
    console.log('Summary:', summary);
}

module.exports = {
    publishTestReports
}; 