'use strict';

const path = require('node:path');
const { loadEnvFile } = require('./env');

// 统一加载环境变量（仅使用项目根目录 .env）
function loadStandardEnv(cwd = process.cwd()) {
  loadEnvFile(path.join(cwd, '.env'));
}

module.exports = {
  loadStandardEnv
};
