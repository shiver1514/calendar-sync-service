'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 读取 .env 文件并注入到 process.env（不覆盖已存在值）
function loadEnvFile(fileName = '.env') {
  const envPath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// 获取必填环境变量
function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

// 获取可选环境变量
function getEnv(name, fallback = '') {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value);
}

// 获取整数型环境变量
function getIntEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer env ${name}: ${value}`);
  }
  return parsed;
}

// 获取布尔型环境变量
function getBoolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

// 读取 CSV 字符串为数组
function getCsvEnv(name, fallback = []) {
  const value = getEnv(name, '');
  if (!value) {
    return fallback;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = {
  loadEnvFile,
  getRequiredEnv,
  getEnv,
  getIntEnv,
  getBoolEnv,
  getCsvEnv
};
