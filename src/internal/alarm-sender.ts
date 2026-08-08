/**
 * 开源构建的告警/状态发送空实现。
 *
 * MetricsWriter 仍可无条件调用统一 sender；开源版本只保留本地 JSONL，不向专有后端发送。
 * 下划线参数表示有意忽略，函数同步且不会抛错。
 */

export function sendAlarm(_topic: string, _data: Record<string, unknown>): void {}
export function sendStatus(_topic: string, _data: Record<string, unknown>): void {}
