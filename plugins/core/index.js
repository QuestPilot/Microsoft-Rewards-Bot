'use strict';
require('bytenode');
const target = process.env.MSRB_CORE_TARGET || process.platform + '-' + process.arch + '-node-' + process.versions.node;
if (!/^(win32|linux|darwin)-(x64|arm64)-node-\d+\.\d+\.\d+$/.test(target)) {
  throw new Error('MSRB_CORE_TARGET value is invalid or unsafe: ' + target);
}
const path = require('path');
const resolved = path.resolve(__dirname, 'targets', target, 'index.jsc');
const targetsDir = path.resolve(__dirname, 'targets');
if (!resolved.startsWith(targetsDir + path.sep)) {
  throw new Error('MSRB_CORE_TARGET resolves outside targets directory');
}
module.exports = require(resolved);
