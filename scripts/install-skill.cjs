#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const agent = process.argv[2] || 'codex';
const destinations = {codex: '.codex/skills', claude: '.claude/skills', agents: '.agents/skills'};
if (!destinations[agent]) { console.error('Usage: node scripts/install-skill.cjs codex|claude|agents [destination-root]'); process.exit(1); }
const destination = path.resolve(process.argv[3] || path.join(os.homedir(), destinations[agent]), 'jiuliu-pet');
if (fs.existsSync(destination)) { console.error('目标已存在，保留原技能：' + destination); process.exit(1); }
fs.mkdirSync(path.join(destination, 'bin'), {recursive: true});
fs.copyFileSync(path.join(root, 'skills/jiuliu-pet/SKILL.md'), path.join(destination, 'SKILL.md'));
fs.copyFileSync(path.join(root, 'bin/kurumi.cjs'), path.join(destination, 'bin/kurumi.cjs'));
console.log(JSON.stringify({ok:true, agent, destination, usage:'node '+JSON.stringify(path.join(destination,'bin/kurumi.cjs'))+' status'}, null, 2));
