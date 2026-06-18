const fs = require('fs');
const html = fs.readFileSync('Page/Dashboard – Microsoft Rewards (6_18_2026 11：41：41 AM).html', 'utf8');

const matches = html.match(/"availablePoints"\s*:\s*\d+/g);
console.log('availablePoints matches:', matches);

// Let's also look for pointProgressMax
const pointProgressMatches = html.match(/"pointProgressMax"\s*:\s*\d+/g);
console.log('pointProgressMax matches:', pointProgressMatches ? pointProgressMatches.length : 0);

// Let's dump the JSON-like objects that contain "pointProgress"
const pointProgressPos = html.indexOf('"pointProgress"');
if (pointProgressPos > -1) {
    console.log('Context around pointProgress:');
    console.log(html.substring(pointProgressPos - 200, pointProgressPos + 200));
}
