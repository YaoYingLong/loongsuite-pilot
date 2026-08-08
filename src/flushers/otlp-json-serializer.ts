/**
 * OpenTelemetry ReadableSpan 的诊断 JSON 序列化器。
 *
 * OtlpTraceFlusher 用它写 `otlp-debug` 和 `otlp-failed` JSONL。结果是便于排障的简化 JSON，
 * 不是发往远端的 OTLP protobuf，也不包含 SDK 对象中的所有内部字段。
 */

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

/**
 * 将 Span 数组逐条序列化为简化 JSON 字符串。
 *
 * @param spans 转换器在内存 Exporter 中完成的 ReadableSpan。
 * @returns 与输入同序的一行一个 Span JSON 字符串数组。
 */
export function createReadableSpanToOtlpSpanJsonArray(spans: ReadableSpan[]): string[] {
  return spans.map((span) => {
    const obj = {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTimeUnixNano: hrTimeToNano(span.startTime),
      endTimeUnixNano: hrTimeToNano(span.endTime),
      attributes: span.attributes,
      status: span.status,
      resource: span.resource?.attributes,
    };
    return JSON.stringify(obj);
  });
}

/** 将 OTel `[seconds,nanoseconds]` 高精度时间转换成十进制纳秒字符串。 */
function hrTimeToNano(hrTime: [number, number]): string {
  const [seconds, nanos] = hrTime;
  return `${BigInt(seconds) * BigInt(1_000_000_000) + BigInt(nanos)}`;
}
