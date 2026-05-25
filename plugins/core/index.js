'use strict';
require('bytenode');
const target = process.env.MSRB_CORE_TARGET || process.platform + '-' + process.arch + '-node-' + process.versions.node;
module.exports = require('./targets/' + target + '/index.jsc');
