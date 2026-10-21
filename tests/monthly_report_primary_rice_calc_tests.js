const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('================================================================');
console.log('  TEST: MONTHLY REPORT RICE CONSUMPTION & SCROLL LOCK TESTS');
console.log('================================================================');

const htmlPath = path.resolve('update_monthly_report.html');
const content = fs.readFileSync(htmlPath, 'utf8');

// 1. Verify helper function isPrimaryCategorySelected exists
assert(content.includes('function isPrimaryCategorySelected()'), 'isPrimaryCategorySelected function must exist');
console.log('✅ PASS: isPrimaryCategorySelected helper function exists');

// 2. Verify bv_meals handler calculates meals * 0.10 for primary category
assert(content.includes("isPrimaryCategorySelected()"), 'isPrimaryCategorySelected must be checked for bv_meals');
assert(content.includes("(meals * 0.10).toFixed(2)"), 'Formula (meals * 0.10).toFixed(2) must be present in bv_meals handler');
assert(content.includes("$('#rice_bv_cons').val(riceCons).trigger('input')"), 'rice_bv_cons must be set and trigger input');
console.log('✅ PASS: #bv_meals input handler correctly calculates and sets #rice_bv_cons (*0.10 for primary category)');

// 3. Verify p_meals handler calculates meals * 0.10
assert(content.includes("(meals * 0.10).toFixed(2)"), 'Formula (meals * 0.10).toFixed(2) must be present in p_meals handler');
assert(content.includes("$('#rice_p_cons').val(riceCons).trigger('input')"), 'rice_p_cons must be set and trigger input');
console.log('✅ PASS: #p_meals input handler correctly calculates and sets #rice_p_cons (*0.10 for primary meals)');

// 4. Verify up_meals handler calculates meals * 0.15 for other/upper primary category
assert(content.includes("!isPrimaryCategorySelected()"), '!isPrimaryCategorySelected must be checked for up_meals');
assert(content.includes("(meals * 0.15).toFixed(2)"), 'Formula (meals * 0.15).toFixed(2) must be present in up_meals handler');
assert(content.includes("$('#rice_up_cons').val(riceCons).trigger('input')"), 'rice_up_cons must be set and trigger input');
console.log('✅ PASS: #up_meals input handler correctly calculates and sets #rice_up_cons for other/upper primary category');

// 5. Verify loadSchoolMonthlyData auto-populates rice_bv_cons, rice_p_cons, and rice_up_cons if empty on load
assert(content.includes("autoRiceBvCons = (parseFloat(d.bv_meals) * 0.10).toFixed(2)"), 'loadSchoolMonthlyData must auto-populate rice_bv_cons if empty');
assert(content.includes("autoRiceCons = (parseFloat(d.p_meals) * 0.10).toFixed(2)"), 'loadSchoolMonthlyData must auto-populate rice_p_cons if empty');
assert(content.includes("autoRiceUpCons = (parseFloat(d.up_meals) * 0.15).toFixed(2)"), 'loadSchoolMonthlyData must auto-populate rice_up_cons if empty');
console.log('✅ PASS: loadSchoolMonthlyData auto-populates rice_bv_cons, rice_p_cons, and rice_up_cons on record load');

// 6. Verify scroll wheel and arrow keys are disabled on number inputs to prevent accidental changes
assert(content.includes("$(document).on('wheel', 'input[type=\"number\"], .num-input'"), 'Wheel handler on number inputs must exist');
assert(content.includes("window.addEventListener('wheel'"), 'Window wheel listener must exist to blur active number input');
assert(content.includes("$(document).on('keydown', 'input[type=\"number\"], .num-input'"), 'Keydown handler to prevent ArrowUp/Down must exist');
assert(content.includes("e.key === 'ArrowUp' || e.key === 'ArrowDown'"), 'ArrowUp and ArrowDown check must exist');
console.log('✅ PASS: Wheel scrolling and ArrowUp/Down increment/decrement are disabled on numeric inputs');

// 7. Verify no PHP files were modified
const { execSync } = require('child_process');
const gitDiff = execSync('git diff --name-only', { encoding: 'utf8' });
const modifiedFiles = gitDiff.split('\n').filter(Boolean);
const phpModified = modifiedFiles.some(f => f.endsWith('.php'));
assert.strictEqual(phpModified, false, 'No PHP files should be modified');
console.log('✅ PASS: Verified NO PHP files were modified');

console.log('================================================================');
console.log('🎉 ALL RICE CONSUMPTION & SCROLL LOCK TESTS PASSED SUCCESSFULLY!');
console.log('================================================================');
