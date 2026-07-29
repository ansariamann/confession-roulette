const { execSync } = require('child_process');
const fs = require('fs');
const out = execSync('git diff HEAD').toString();
fs.writeFileSync('git_diff_output.txt', out);
