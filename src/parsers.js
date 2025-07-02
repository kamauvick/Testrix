const fs = require('fs');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const XLSX = require('xlsx');

/**
 * Parse JUnit XML file
 * @param {string} filePath - Path to the JUnit XML file
 * @returns {Promise<Object>} Parsed test results
 */
async function parseJUnit(filePath) {
    const xmlData = fs.readFileSync(filePath, 'utf8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(xmlData);
    
    const testSuites = result.testsuites?.testsuite || [result.testsuite];
    const summary = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0
    };
    
    const testCases = [];
    
    testSuites.forEach(suite => {
        const suiteTime = parseFloat(suite.$.time || 0);
        summary.duration += suiteTime;
        
        if (suite.testcase) {
            suite.testcase.forEach(test => {
                const testCase = {
                    title: test.$.name,
                    status: 'passed',
                    duration: parseFloat(test.$.time || 0),
                    errorMessage: null,
                    errorStack: null,
                    file: test.$.classname || null,
                    suite: suite.$.name || null
                };
                
                if (test.skipped) {
                    testCase.status = 'skipped';
                    summary.skipped++;
                } else if (test.failure || test.error) {
                    testCase.status = 'failed';
                    const failureOrError = (test.failure || test.error)[0];
                    testCase.errorMessage = failureOrError.$.message;
                    testCase.errorStack = failureOrError._ || null;
                    summary.failed++;
                } else {
                    summary.passed++;
                }
                
                testCases.push(testCase);
                summary.total++;
            });
        }
    });
    
    return { summary, testCases };
}

/**
 * Parse HTML test report
 * @param {string} filePath - Path to the HTML file
 * @returns {Promise<Object>} Parsed test results
 */
async function parseHTML(filePath) {
    const htmlData = fs.readFileSync(filePath, 'utf8');
    const $ = cheerio.load(htmlData);
    
    const summary = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0
    };
    
    const testCases = [];
    
    // Look for common test report patterns
    $('.test-case, .test, tr.test').each((_, element) => {
        const $el = $(element);
        const title = $el.find('.name, .test-name').text().trim();
        const status = $el.find('.status, .result').text().trim().toLowerCase();
        const duration = parseFloat($el.find('.duration, .time').text().trim()) || 0;
        const error = $el.find('.error, .failure, .message').text().trim();
        
        const testCase = {
            title,
            status: status === 'pass' ? 'passed' : status === 'fail' ? 'failed' : 'skipped',
            duration,
            error: error || null
        };
        
        testCases.push(testCase);
        summary.total++;
        
        switch (testCase.status) {
            case 'passed':
                summary.passed++;
                break;
            case 'failed':
                summary.failed++;
                break;
            case 'skipped':
                summary.skipped++;
                break;
        }
        
        summary.duration += duration;
    });
    
    return { summary, testCases };
}

/**
 * Parse Excel test report
 * @param {string} filePath - Path to the Excel file
 * @returns {Promise<Object>} Parsed test results
 */
async function parseExcel(filePath) {
    const workbook = XLSX.readFile(filePath);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(firstSheet);
    
    const summary = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0
    };
    
    const testCases = data.map(row => {
        const testCase = {
            title: row['Test Name'] || row['Name'] || row['Test'],
            status: (row['Status'] || row['Result'] || '').toLowerCase(),
            duration: parseFloat(row['Duration'] || row['Time'] || 0),
            error: row['Error'] || row['Message'] || null
        };
        
        // Normalize status
        if (testCase.status === 'pass') testCase.status = 'passed';
        else if (testCase.status === 'fail') testCase.status = 'failed';
        else if (testCase.status === 'skip') testCase.status = 'skipped';
        
        summary.total++;
        switch (testCase.status) {
            case 'passed':
                summary.passed++;
                break;
            case 'failed':
                summary.failed++;
                break;
            case 'skipped':
                summary.skipped++;
                break;
        }
        
        summary.duration += testCase.duration;
        
        return testCase;
    });
    
    return { summary, testCases };
}

module.exports = { parseJUnit, parseHTML, parseExcel };