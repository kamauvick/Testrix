#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { publishTestReports } = require('./src/publisher');

async function main() {
    try {
        const args = process.argv.slice(2);
        const configPath = args[0] || 'config.json';

        console.log('Reading config from:', configPath);
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        await publishTestReports(config);
        
    } catch (error) {
        console.error('Error:', error.message);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        process.exit(1);
    }
}

main(); 