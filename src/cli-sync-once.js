'use strict';

const { loadSyncConfig } = require('./sync/config');
const { syncOnce } = require('./sync/sync-once');
const { createLogger } = require('./lib/logger');

async function main() {
  const config = loadSyncConfig();
  const logger = createLogger({
    component: 'cli.sync-once',
    logFile: config.service.logFile,
    minLevel: config.service.logLevel
  });
  const result = await syncOnce(config, {
    logger,
    trigger: 'cli-sync-once'
  });

  const sourceCalendars = Array.isArray(result.selectedCalendars && result.selectedCalendars.dingtalk)
    ? result.selectedCalendars.dingtalk
    : [result.selectedCalendars && result.selectedCalendars.dingtalk].filter(Boolean);
  const sourceSummary = sourceCalendars.length
    ? sourceCalendars.map((item) => `${item.name || '(无名称)'} (${item.href})`).join(' | ')
    : '-';

  console.log('\n同步完成：');
  console.log(`  时间窗: ${result.window.start} ~ ${result.window.end}`);
  console.log(`  钉钉来源日历: ${sourceSummary}`);
  console.log(`  iCloud 日历: ${result.selectedCalendars.icloud.name} (${result.selectedCalendars.icloud.href})`);
  console.log(`  总数: ${result.stats.sourceCount}`);
  console.log(`  新建: ${result.stats.created}`);
  console.log(`  更新: ${result.stats.updated}`);
  console.log(`  跳过: ${result.stats.skipped}`);
  console.log(`  删除候选: ${result.stats.deleteCandidates}`);
  console.log(`  删除待确认: ${result.stats.deletePendingConfirm}`);
  console.log(`  计划删除(DryRun): ${result.stats.deletePlanned}`);
  console.log(`  已删除: ${result.stats.deleted}`);
  console.log(`  删除保护跳过: ${result.stats.deleteSkippedByGuard}`);
  console.log(`  源端仍存在: ${result.stats.deleteSourceAlive}`);
  console.log(`  源端探测失败: ${result.stats.deleteSourceProbeFailed}`);
  console.log(`  失败: ${result.stats.failed}`);
  console.log(`  DryRun: ${result.stats.dryRun}`);
  console.log(`  状态文件: ${result.stateFile}`);
  console.log(`  耗时: ${result.elapsedMs}ms`);
}

main().catch((error) => {
  console.error('\n同步失败：');
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
